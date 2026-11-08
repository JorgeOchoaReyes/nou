import { readFileSync } from "fs";
import path from "path";
import type { AgentHooks } from "../agent/index.js";
import { toRelative } from "../commands/index.js";
import type { ModelChoice } from "../providers/index.js";
import { ExternalEngine, readsInCommand, replaceIn } from "./external.js";
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
    this.closeLive();
    this.claudeSession = undefined;
  }

  snapshot() {
    return this.claudeSession ? { claudeSession: this.claudeSession } : undefined;
  }

  /** Claude Code keeps its sessions on disk, so a saved one resumes in a later run too. */
  restore(state: any): boolean {
    if (typeof state?.claudeSession !== "string") return false;
    this.closeLive();
    this.claudeSession = state.claudeSession;
    return true;
  }

  /** Claude Code can resume its session with another model, so the conversation carries over. */
  setModel(choice: ModelChoice) {
    this.choice = choice;
  }

  dispose() {
    this.closeLive();
  }

  /**
   * One Claude Code process per conversation, kept running between messages: each message is fed into it
   * and a turn is over at its result. A process per message didn't work: one that left something running
   * (a dev server, a background command) never closed its stream, so the turn never ended, and the next
   * message's process found the session still in use and ended without a word.
   */
  private live: { key: string; query: any; push(text: string): void; close(): void } | null = null;
  /** The turn being waited on: settled at its result, or when the process ends. */
  private waiting: { live: object; done(error?: Error): void } | null = null;
  private streamed = "";

  private closeLive() {
    const live = this.live;
    this.live = null;
    live?.close();
  }

  /** What the process was started with; a change (model, effort, project context) means a new one. */
  private liveKey(): string {
    return JSON.stringify([this.choice.provider.id === "anthropic" ? this.choice.model : null, this.effort ?? null, this.extras]);
  }

  private openLive(sdk: any, key: string) {
    const queue: any[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const input = async function* () {
      while (!closed) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    };
    const allow = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    const preToolUse = async (hookInput: any) => {
      const tool: string = hookInput.tool_name;
      const args = (hookInput.tool_input ?? {}) as Record<string, any>;
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
    const postToolUse = async (hookInput: any) => {
      const tool: string = hookInput.tool_name;
      const args = (hookInput.tool_input ?? {}) as Record<string, any>;
      if (EDIT_TOOLS.has(tool) && args.file_path) {
        const problems = await this.tracker.applied(args.file_path);
        return problems
          ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `This edit introduced problems; fix them:\n${problems}` } }
          : {};
      }
      if (tool === "Read" && args.file_path) {
        // A part of the file (offset and limit, in lines): follow mode shows those lines.
        const from = typeof args.offset === "number" ? Math.max(1, args.offset) : undefined;
        const to = from && typeof args.limit === "number" ? from + args.limit - 1 : undefined;
        this.hooks.onRead(toRelative(args.file_path), from, to);
      }
      if ((tool === "Bash" || tool === "PowerShell") && typeof args.command === "string") {
        for (const read of readsInCommand(args.command)) this.hooks.onRead(read.path, read.line, read.to);
      }
      this.hooks.onEntry({ kind: "tool", text: tool === "Bash" || tool === "PowerShell" ? `Ran: ${args.command}` : describeTool(tool, args) });
      return {};
    };

    const query = sdk.query({
      prompt: input(),
      options: {
        cwd: process.cwd(),
        ...(this.claudeSession ? { resume: this.claudeSession } : {}),
        ...(this.choice.provider.id === "anthropic" ? { model: this.choice.model } : {}),
        ...(this.effort && EFFORTS.has(this.effort) ? { effort: this.effort } : {}),
        includePartialMessages: true,
        // Ask for everything not explicitly allowed, so Nou's approvals apply; project settings bring CLAUDE.md.
        permissionMode: "default",
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: this.extras.join("\n\n") },
        hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }] },
        canUseTool: async (tool: string, toolInput: Record<string, any>) => {
          const ok = await this.hooks.approve({ kind: "tool", name: tool, args: toolInput });
          if (!ok) this.hooks.onEntry({ kind: "tool", text: `Denied: ${describeTool(tool, toolInput)}` });
          return ok ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "The user denied this." };
        },
      },
    });
    const live = {
      key,
      query,
      push: (text: string) => {
        queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.claudeSession ?? "" });
        wake?.();
        wake = null;
      },
      close: () => {
        process.off("exit", live.close);
        closed = true;
        wake?.();
        try {
          query.close?.();
        } catch {
          // already gone
        }
      },
    };
    process.once("exit", live.close); // Claude Code doesn't outlive Nou
    // Reads everything Claude Code says, for as long as the process runs. Between turns that's what a
    // background task it started brings back (it may carry on by itself); it goes to the chat too.
    void (async () => {
      let failure: Error | undefined;
      try {
        for await (const message of query) this.handle(message, live);
      } catch (error: any) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (this.live === live) this.live = null;
        if (this.waiting?.live === live) this.waiting.done(failure ?? (closed ? undefined : new Error("Claude Code stopped before it answered.")));
      }
    })();
    return live;
  }

  private handle(message: any, live: object) {
    if (message.type === "system" && message.subtype === "init") {
      this.claudeSession = message.session_id;
    } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        this.streamed += event.delta.text;
        this.hooks.onStream(this.streamed);
      }
    } else if (message.type === "assistant" && !message.parent_tool_use_id) {
      const text = (message.message.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      this.streamed = "";
      this.hooks.onStream("");
      if (text) this.hooks.onEntry({ kind: "assistant", text });
      if (this.waiting) this.hooks.onBusy("Claude Code is working...");
    } else if (message.type === "result") {
      this.claudeSession = message.session_id ?? this.claudeSession;
      this.streamed = "";
      this.hooks.onStream("");
      if (message.subtype !== "success" || message.is_error) {
        const detail = message.errors?.join("; ") || message.result || message.subtype;
        // A turn you stopped ends with an error result; that isn't news.
        if (!this.stopping) this.hooks.onEntry({ kind: "error", text: `Claude Code: ${detail}` });
      }
      this.stopping = false;
      if (this.waiting?.live === live) this.waiting.done();
    }
  }

  private stopping = false;

  protected async run(prompt: string, signal: AbortSignal) {
    const sdk = await loadPackage("@anthropic-ai/claude-agent-sdk");
    const key = this.liveKey();
    if (this.live && this.live.key !== key) this.closeLive();
    const live = (this.live ??= this.openLive(sdk, key));
    this.streamed = "";
    let settle!: (error?: Error) => void;
    const finished = new Promise<void>((resolve, reject) => (settle = (error) => (error ? reject(error) : resolve())));
    const waiting = { live, done: (error?: Error) => settle(error) };
    this.waiting = waiting;
    // Stopping: Claude Code interrupts the turn and ends it with a result; if it doesn't promptly, the
    // process goes (the next message starts a new one, resuming the session).
    const onAbort = () => {
      this.stopping = true;
      Promise.resolve(live.query.interrupt?.()).catch(() => {});
      setTimeout(() => {
        if (this.waiting !== waiting) return;
        if (this.live === live) this.closeLive();
        waiting.done();
      }, 3000);
    };
    signal.addEventListener("abort", onAbort);
    try {
      live.push(prompt);
      await finished;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.waiting === waiting) this.waiting = null;
    }
    if (signal.aborted) throw new Error("aborted");
  }
}
