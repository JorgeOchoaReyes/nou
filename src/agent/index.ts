import { toolDefs } from "../tools/index.js";
import {
  applyChange,
  fileTree,
  proposeEdit,
  proposeWrite,
  readFile,
  runCommand,
  toRelative,
  type FileChange,
} from "../commands/index.js";
import { describe, type ChatMessage, type ModelChoice, type ToolCall, type ToolDef } from "../providers/index.js";

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
  onChange(change: FileChange, status: ChangeStatus): void;
  approve(request: ApprovalRequest): Promise<boolean>;
}

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

export class Agent {
  private messages: ChatMessage[] = [];
  private controller: AbortController | null = null;
  private extraTools: ExtraTool[] = [];
  private effort: string | undefined;

  constructor(public choice: ModelChoice, private system: string, private hooks: AgentHooks) {}

  configure(options: { system?: string; extraTools?: ExtraTool[]; effort?: string }) {
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
  }

  cancel() {
    this.controller?.abort();
  }

  /** `context` (what the user is looking at) is sent to the model but not shown in the chat. */
  async send(text: string, context?: string) {
    this.messages.push({ role: "user", content: context ? `${text}\n\n${context}` : text });
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

        this.messages.push({
          role: "assistant",
          content: result.text,
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
          const output = problem ?? await this.runTool(call);
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
        this.hooks.onRead(toRelative(args.path));
        this.hooks.onEntry({ kind: "tool", text: `Read ${args.path}` });
        return await readFile(args.path);
      }
      case "list_files":
      case "get_file_tree": {
        this.hooks.onEntry({ kind: "tool", text: `Listed ${args.path ?? "."}` });
        return fileTree(args.path ?? ".", 4);
      }
      case "edit_file":
      case "write_file": {
        const change = name === "edit_file"
          ? await proposeEdit(args.path, args.old_string, args.new_string)
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
    this.hooks.onChange(change, "pending");
    const ok = await this.hooks.approve({ kind: "change", change });
    if (!ok) {
      this.hooks.onChange(change, "rejected");
      this.hooks.onEntry({ kind: "tool", text: `Rejected edit to ${change.path}` });
      return "User rejected this change. Ask them what they would like instead.";
    }
    const result = await applyChange(change);
    this.hooks.onChange(change, "applied");
    this.hooks.onEntry({ kind: "tool", text: result });
    return result;
  }
}
