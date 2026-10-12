import { randomUUID } from "crypto";
import { toolDefs } from "../tools/index.js";
import {
  applyChange,
  capOutput,
  fileTree,
  isInProject,
  proposeEdit,
  proposeWrite,
  readForModel,
  runCommand,
  toRelative,
  type FileChange,
} from "../commands/index.js";
import { describe, type ChatMessage, type ModelChoice, type ToolCall, type ToolDef } from "../providers/index.js";
import { newCallId } from "../providers/ids.js";
import type { Engine, EngineOptions } from "../engines/types.js";

const MAX_STEPS = 25;

export type ChatEntry = {
  kind: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
};

export type ApprovalRequest =
  | { kind: "command"; command: string }
  | { kind: "change"; change: FileChange }
  | { kind: "tool"; name: string; args: Record<string, any> };

/** Tools added on top of the built-ins (git, plugins). */
export type ExtraTool = {
  definition: ToolDef;
  /** Read-only tools run without asking. */
  readOnly: boolean;
  source: string;
  run(args: Record<string, any>): Promise<string> | string;
};

export type ChangeStatus = "pending" | "applied" | "rejected";

/** How the agent talks to the UI. */
export interface AgentHooks {
  onEntry(entry: ChatEntry): void;
  onStream(partial: string): void;
  onBusy(label: string | null): void;
  onRead(path: string): void;
  /** `turn` is unique across sessions (session id + turn number), so undo can target one turn exactly. */
  onChange(change: FileChange, status: ChangeStatus, turn: string): void;
  approve(request: ApprovalRequest): Promise<boolean>;
  /** After an edit is applied: problems it introduced, reported back to the model so it can fix them. */
  checkChange?(change: FileChange): Promise<string | null>;
}

/** Unique per conversation, since turn numbers restart at 1 every session. */
export const newSessionId = () => `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

export function buildSystemPrompt(permContext: string, extras: string[] = []): string {
  return `You are Nou, a coding assistant running in the user's terminal, working in ${process.cwd()}.
You can read, edit and create files and run commands with the tools you have.
- Read a file before editing it. Prefer edit_file for small changes and write_file for new files.
- Every edit and command is shown to the user, who approves or rejects it.
- Keep replies short and to the point.

Project files:
${fileTree(".", 3)}
${extras.map((e) => `\n${e}`).join("")}
${permContext}`;
}

/** Checks required arguments are present before a tool runs (models, especially small local ones, skip them). */
function invalidArgs(call: ToolCall, tools: ToolDef[]): string | null {
  if ("__invalid_json" in call.args) return `The arguments were not valid JSON: ${JSON.stringify(call.args.__invalid_json)}`;
  const def = tools.find((t) => t.name === call.name);
  if (!def) return null;
  const missing = def.parameters.required.filter((key) => call.args[key] === undefined || call.args[key] === null);
  return missing.length ? `Missing or non-string arguments: ${missing.join(", ")}` : null;
}

/** Nou's own engine: its tools, prompt and loop, with any model. */
export class Agent implements Engine {
  readonly id = "nou" as const;
  private messages: ChatMessage[] = [];
  private controller: AbortController | null = null;
  private extraTools: ExtraTool[] = [];
  private effort: string | undefined;
  private notes: string[] = [];
  /** Increments per user message; tags changes so a whole turn can be rewound. */
  turn = 0;
  /** Distinguishes this run from earlier ones, since turn numbers restart at 1 every session. */
  readonly session = newSessionId();

  get turnId(): string {
    return `${this.session}:${this.turn}`;
  }

  constructor(public choice: ModelChoice, private system: string, private hooks: AgentHooks) {}

  configure(options: EngineOptions) {
    if (options.system !== undefined) this.system = options.system;
    if (options.extraTools) this.extraTools = options.extraTools;
    if (options.effort) this.effort = options.effort;
  }

  get tools(): ToolDef[] {
    return [...toolDefs, ...this.extraTools.map((t) => t.definition)];
  }

  /** Switches model; the conversation carries over. */
  setModel(choice: ModelChoice) {
    this.choice = choice;
  }

  clear() {
    this.messages = [];
    this.notes = [];
  }

  /** Something the model should know before the next message (e.g. the user undid its edit). */
  note(text: string) {
    this.notes.push(text);
  }

  cancel() {
    this.controller?.abort();
  }

  /** `context` (what the user is looking at) is sent to the model but not shown in the chat. */
  async send(text: string, context?: string) {
    this.turn++;
    const notes = this.notes.length ? `${this.notes.map((n) => `[Note: ${n}]`).join("\n")}\n\n` : "";
    this.notes = [];
    this.messages.push({ role: "user", content: `${notes}${text}${context ? `\n\n${context}` : ""}` });
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.hooks.onBusy(`Pondering with ${describe(this.choice)}...`);
        let streamed = "";
        const result = await this.choice.provider.chat({
          model: this.choice.model,
          system: this.system,
          messages: this.messages,
          tools: this.tools,
          signal,
          ...(this.effort ? { effort: this.effort } : {}),
          onText: (delta) => {
            streamed += delta;
            this.hooks.onStream(streamed);
          },
        });
        this.hooks.onStream("");

        // Tool-call ids must be unique across the conversation (results are matched by id, and some APIs
        // reject duplicates). Some providers reuse ids, so rename any repeat. Claude's own copy of the turn
        // (raw) keeps its ids, which the API guarantees are unique.
        const used = new Set(this.messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => c.id) : [])));
        for (const call of result.toolCalls) {
          if (used.has(call.id) && !result.raw) call.id = newCallId();
          used.add(call.id);
        }

        this.messages.push({
          role: "assistant",
          // Local reasoning models think in <think> blocks; sending those back only uses up context.
          content: result.raw ? result.text : result.text.replace(/<think>[\s\S]*?<\/think>\s*/g, ""),
          toolCalls: result.toolCalls,
          ...(result.raw ? { raw: result.raw } : {}),
        });
        const visible = result.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (visible) this.hooks.onEntry({ kind: "assistant", text: visible });

        if (result.stop === "refusal") {
          this.hooks.onEntry({ kind: "error", text: "The model declined this request." });
          this.dropUnansweredCalls();
          return;
        }
        if (result.stop === "max_tokens") {
          this.hooks.onEntry({ kind: "error", text: "The response was cut off before its tool call finished. Try asking for a smaller change." });
          this.dropUnansweredCalls();
          return;
        }
        if (result.toolCalls.length === 0) return;

        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          this.hooks.onBusy(`Running ${call.name}...`);
          const problem = invalidArgs(call, this.tools);
          const output = problem ?? capOutput(await this.runTool(call));
          this.messages.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: problem ? `Error: ${problem}` : output,
            ...(problem ? { isError: true } : {}),
          });
        }
        if (signal.aborted) throw new Error("aborted");
      }
      this.hooks.onEntry({ kind: "error", text: `Stopped after ${MAX_STEPS} steps.` });
    } catch (error: any) {
      this.hooks.onStream("");
      if (signal.aborted) {
        this.hooks.onEntry({ kind: "info", text: "Cancelled." });
      } else {
        this.hooks.onEntry({ kind: "error", text: `${describe(this.choice)}: ${error.message}` });
      }
      this.dropUnansweredCalls();
    } finally {
      this.controller = null;
      this.hooks.onBusy(null);
    }
  }

  /** Every tool call needs a result before the next request, or most APIs reject the history. */
  private dropUnansweredCalls() {
    const answered = new Set(this.messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])));
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      for (const call of m.toolCalls) {
        if (answered.has(call.id)) continue;
        this.messages.push({ role: "tool", callId: call.id, name: call.name, content: "Not run: the turn was interrupted.", isError: true });
        answered.add(call.id);
      }
    }
  }

  private async runTool(call: ToolCall): Promise<string> {
    const { name, args } = call;
    try {
      switch (name) {
      case "read_file": {
        // Files outside the project (e.g. ~/.ssh) need your OK, like commands do.
        if (!isInProject(args.path)) {
          if (!(await this.hooks.approve({ kind: "tool", name, args }))) {
            this.hooks.onEntry({ kind: "tool", text: `Denied: read ${args.path}` });
            return "User denied reading this file: it is outside the project folder.";
          }
        } else {
          this.hooks.onRead(toRelative(args.path));
        }
        this.hooks.onEntry({ kind: "tool", text: `Read ${args.path}` });
        return await readForModel(args.path, args.offset, args.limit);
      }
      case "list_files":
      case "get_file_tree": {
        this.hooks.onEntry({ kind: "tool", text: `Listed ${args.path ?? "."}` });
        return fileTree(args.path ?? ".", 4);
      }
      case "edit_file":
      case "write_file": {
        const change = name === "edit_file"
          ? await proposeEdit(args.path, args.old_string, args.new_string, args.replace_all === true)
          : await proposeWrite(args.path, args.content ?? "");
        return await this.reviewChange(change);
      }
      case "run_command": {
        const ok = await this.hooks.approve({ kind: "command", command: args.command });
        if (!ok) {
          this.hooks.onEntry({ kind: "tool", text: `Denied: ${args.command}` });
          return "User denied permission to run this command.";
        }
        this.hooks.onEntry({ kind: "tool", text: `Ran: ${args.command}` });
        const output = await runCommand(args.command);
        return output.trim() || "(no output)";
      }
      default: {
        const extra = this.extraTools.find((t) => t.definition.name === name);
        if (!extra) return `Unknown tool: ${name}`;
        if (!extra.readOnly && !(await this.hooks.approve({ kind: "tool", name, args }))) {
          this.hooks.onEntry({ kind: "tool", text: `Denied: ${name}` });
          return "User denied permission to run this tool.";
        }
        this.hooks.onEntry({ kind: "tool", text: `${extra.source}: ${name}${args.path ? ` ${args.path}` : ""}` });
        return String(await extra.run(args));
      }
      }
    } catch (error: any) {
      this.hooks.onEntry({ kind: "error", text: `${name}: ${error.message}` });
      return `Error: ${error.message}`;
    }
  }

  private async reviewChange(change: FileChange): Promise<string> {
    this.hooks.onChange(change, "pending", this.turnId);
    const ok = await this.hooks.approve({ kind: "change", change });
    if (!ok) {
      this.hooks.onChange(change, "rejected", this.turnId);
      this.hooks.onEntry({ kind: "tool", text: `Rejected edit to ${change.path}` });
      return "User rejected this change. Ask them what they would like instead.";
    }
    const result = await applyChange(change);
    this.hooks.onChange(change, "applied", this.turnId);
    this.hooks.onEntry({ kind: "tool", text: result });
    if (result.startsWith("Failed")) return result;
    this.hooks.onBusy(`Checking ${change.path} for problems...`);
    const problems = await this.hooks.checkChange?.(change).catch(() => null);
    if (problems) this.hooks.onEntry({ kind: "error", text: `New problems in ${change.path}:\n${problems}` });
    return problems ? `${result}\n\nThis edit introduced problems; fix them:\n${problems}` : result;
  }
}
