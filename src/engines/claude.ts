import { readFileSync } from "fs";
import path from "path";
import type { AgentHooks } from "../agent/index.js";
import { toRelative } from "../commands/index.js";
import type { ModelChoice } from "../providers/index.js";
import { ExternalEngine, replaceIn } from "./external.js";
import { loadPackage } from "./index.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Claude Code tools that change files; Nou previews and approves them. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function current(filePath: string): string | null {
  try {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return null;
  }
}

/** The file's content after a Claude Code edit, or undefined if it can't be worked out in advance. */
export function proposedContent(tool: string, input: Record<string, any>): string | undefined {
  if (tool === "Write") return String(input.content ?? "");
  const before = current(input.file_path);
  if (before === null) return undefined;
  if (tool === "Edit") return replaceIn(before, input.old_string, input.new_string, input.replace_all === true) ?? undefined;
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    let text: string | null = before;
    for (const edit of input.edits) text = text === null ? null : replaceIn(text, edit.old_string, edit.new_string, edit.replace_all === true);
    return text ?? undefined;
  }
  return undefined;
}

/** A short line for the chat about a tool Claude Code ran. */
function describeTool(tool: string, input: Record<string, any>): string {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  return `${tool}${target ? ` ${typeof target === "string" && input.file_path ? toRelative(target) : target}` : ""}`;
}

/**
 * Claude Code through the Claude Agent SDK. Its PreToolUse hook sends every edit and command to Nou's
 * approval (with a diff for edits); PostToolUse records what changed for undo and feeds problems back.
 */
export class ClaudeCodeEngine extends ExternalEngine {
  readonly id = "claude-code" as const;
  /** Claude Code's session, resumed for each message so the conversation carries on. */
  private claudeSession: string | undefined;

  constructor(choice: ModelChoice, hooks: AgentHooks) {
    super(choice, hooks, "Claude Code");
  }

  protected resetConversation() {
    this.claudeSession = undefined;
  }

  snapshot() {
    return this.claudeSession ? { claudeSession: this.claudeSession } : undefined;
  }

  /** Claude Code keeps its sessions on disk, so a saved one resumes in a later run too. */
  restore(state: any): boolean {
    if (typeof state?.claudeSession !== "string") return false;
    this.claudeSession = state.claudeSession;
    return true;
  }

  /** Claude Code can resume its session with another model, so the conversation carries over. */
  setModel(choice: ModelChoice) {
    this.choice = choice;
  }

  protected async run(prompt: string, signal: AbortSignal) {
    const sdk = await loadPackage("@anthropic-ai/claude-agent-sdk");
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort());
    const allow = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

    const preToolUse = async (input: any) => {
      const tool: string = input.tool_name;
      const args = (input.tool_input ?? {}) as Record<string, any>;
      if (EDIT_TOOLS.has(tool) && args.file_path) {
        const ok = await this.tracker.approve(args.file_path, proposedContent(tool, args), tool);
        return ok ? allow : deny("The user rejected this change. Ask them what they would like instead.");
      }
      if (tool === "Bash" || tool === "PowerShell") {
        const ok = await this.hooks.approve({ kind: "command", command: String(args.command ?? "") });
        if (!ok) this.hooks.onEntry({ kind: "tool", text: `Denied: ${args.command}` });
        return ok ? allow : deny("The user denied permission to run this command.");
      }
      // Reads and searches follow Claude Code's own rules; anything else that needs asking reaches canUseTool.
      return {};
    };

    const postToolUse = async (input: any) => {
      const tool: string = input.tool_name;
      const args = (input.tool_input ?? {}) as Record<string, any>;
      if (EDIT_TOOLS.has(tool) && args.file_path) {
        const problems = await this.tracker.applied(args.file_path);
        return problems
          ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `This edit introduced problems; fix them:\n${problems}` } }
          : {};
      }
      if (tool === "Read" && args.file_path) this.hooks.onRead(toRelative(args.file_path));
      this.hooks.onEntry({ kind: "tool", text: tool === "Bash" || tool === "PowerShell" ? `Ran: ${args.command}` : describeTool(tool, args) });
      return {};
    };

    const query = sdk.query({
      prompt,
      options: {
        cwd: process.cwd(),
        abortController,
        ...(this.claudeSession ? { resume: this.claudeSession } : {}),
        ...(this.choice.provider.id === "anthropic" ? { model: this.choice.model } : {}),
        ...(this.effort && EFFORTS.has(this.effort) ? { effort: this.effort } : {}),
        includePartialMessages: true,
        // Ask for everything not explicitly allowed, so Nou's approvals apply; project settings bring CLAUDE.md.
        permissionMode: "default",
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: this.extras.join("\n\n") },
        hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }] },
        canUseTool: async (tool: string, input: Record<string, any>) => {
          const ok = await this.hooks.approve({ kind: "tool", name: tool, args: input });
          if (!ok) this.hooks.onEntry({ kind: "tool", text: `Denied: ${describeTool(tool, input)}` });
          return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user denied this." };
        },
      },
    });

    let streamed = "";
    for await (const message of query) {
      if (message.type === "system" && message.subtype === "init") {
        this.claudeSession = message.session_id;
      } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          streamed += event.delta.text;
          this.hooks.onStream(streamed);
        }
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        const text = (message.message.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        streamed = "";
        this.hooks.onStream("");
        if (text) this.hooks.onEntry({ kind: "assistant", text });
        this.hooks.onBusy("Claude Code is working...");
      } else if (message.type === "result") {
        this.claudeSession = message.session_id ?? this.claudeSession;
        if (message.subtype !== "success" || message.is_error) {
          const detail = message.errors?.join("; ") || message.result || message.subtype;
          if (!signal.aborted) this.hooks.onEntry({ kind: "error", text: `Claude Code: ${detail}` });
        }
      }
    }
    if (signal.aborted) throw new Error("aborted");
  }
}
