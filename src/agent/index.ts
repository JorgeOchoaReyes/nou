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
import { globFiles, grep } from "../search/index.js";

/** Model requests per user message before stopping; real tasks (explore, edit, test, fix) take a few dozen. */
const MAX_STEPS = 60;
/** Messages kept word for word when older ones are summarized. */
const KEEP_RECENT = 8;
const TRIMMED_OUTPUT = "\n[... trimmed to save context; run the tool again if you need it]";

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

/** How many lines of the project tree go in the system prompt; the model can glob or list_files for more. */
const PROMPT_TREE_LINES = 150;

export function buildSystemPrompt(permContext: string, extras: string[] = []): string {
  const shell = process.platform === "win32" ? "Windows (commands run in cmd.exe)" : `${process.platform} (commands run in sh)`;
  return `You are Nou, a coding agent in the user's terminal. You work in ${process.cwd()} on ${shell}.

How to work:
1. Look before you change anything. Use grep to find where things are defined and used, glob to find files by name, and read_file for the parts you need. Never guess what a file contains.
2. Make the smallest change that does what was asked, in the style of the surrounding code. Use edit_file for changes, copying old_string exactly from what you read (replace_all renames every occurrence in a file). Use write_file only for new files or complete rewrites.
3. Check your work. If the project has tests, a build or a type check, run them with run_command and fix what you broke. If it has none, try new code on the examples the user gave (a one-line script is enough). Problems the editor finds after an edit are reported back to you: fix them.
4. Keep going until the task is done. The user approves each edit and command as it happens, so don't stop to ask permission between steps; ask only when the request is unclear or you need a decision.
5. End with a short summary of what you changed and why. When the user only asks a question, answer it without editing anything.

- If the user rejects an edit or command, don't retry it: ask what they would like instead.
- Keep replies short. Refer to code as path:line.

Project files:
${fileTree(".", 3, PROMPT_TREE_LINES)}
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

  /** Roughly what each request sends, in characters (about 4 per token): prompt, tool schemas and history. */
  requestSize(): number {
    return this.system.length + JSON.stringify(this.tools).length + JSON.stringify(this.messages).length;
  }

  /**
   * How much context to stay under, in characters. Local models get a 32k-token window from Nou (see
   * providers/ollama.ts), so ~90k characters leaves room for the reply; cloud models have far more.
   */
  contextBudget(): number {
    const set = Number(process.env.NOU_CONTEXT_CHARS);
    if (set > 0) return set;
    return this.choice.provider.local ? 90_000 : 500_000;
  }

  /**
   * Makes the conversation fit the model's context: first trims old tool output (the bulk of it, and
   * rarely needed again), then, if that isn't enough, has the model summarize older messages. `force`
   * (the /compact command) summarizes even when it fits. Returns whether anything changed.
   */
  async compact(force = false, signal?: AbortSignal): Promise<boolean> {
    const budget = this.contextBudget();
    const startSize = this.requestSize();
    // The latest step's results are what the model is working from; it has already used the older ones.
    const lastStep = this.messages.findLastIndex((m) => m.role === "assistant");
    let trimmed = 0;
    for (let i = 0; i < lastStep; i++) {
      const m = this.messages[i]!;
      if (m.role === "tool" && m.content.length > TRIMMED_OUTPUT.length + 400) {
        this.messages[i] = { ...m, content: `${m.content.slice(0, 300)}${TRIMMED_OUTPUT}` };
        trimmed++;
      }
    }
    if (!force && this.requestSize() <= budget * 0.8) {
      this.hooks.onEntry({ kind: "info", text: `Trimmed ${trimmed} old tool outputs to fit the model's context.` });
      return true;
    }

    const split = this.summarySplit();
    if (split <= 0) return trimmed > 0;
    this.hooks.onBusy("Summarizing the conversation to fit the model's context...");
    let summary: string;
    try {
      summary = await this.summarize(this.messages.slice(0, split), signal);
    } catch (error: any) {
      if (signal?.aborted) throw error;
      summary = `(The earlier conversation was dropped to fit the context; summarizing it failed: ${error.message})`;
    }
    const intro = `[Summary of the conversation so far]\n${summary}`;
    const rest = this.messages.slice(split);
    const first = rest[0];
    this.messages = first?.role === "user"
      ? [{ ...first, content: `${intro}\n\n${first.content}` }, ...rest.slice(1)]
      : [{ role: "user", content: intro }, ...rest];
    this.hooks.onEntry({
      kind: "info",
      text: `Summarized ${split} earlier messages to fit the model's context (${Math.round(startSize / 1000)}k → ${Math.round(this.requestSize() / 1000)}k characters).`,
    });
    return true;
  }

  /**
   * Where to cut the history for a summary: as late as possible while keeping the last few messages, and
   * only before a user or assistant message, so no tool call is separated from its result.
   */
  private summarySplit(): number {
    for (let i = this.messages.length - KEEP_RECENT; i > 0; i--) {
      if (this.messages[i]?.role !== "tool") return i;
    }
    return 0;
  }

  private async summarize(older: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
    const transcript = older.map((m) => {
      if (m.role === "user") return `USER: ${clip(m.content, 4000)}`;
      if (m.role === "tool") return `TOOL RESULT (${m.name}): ${clip(m.content, 600)}`;
      const calls = m.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.args), 300)})`).join(", ");
      return `ASSISTANT: ${clip(m.content, 2000)}${calls ? `\n  called: ${calls}` : ""}`;
    }).join("\n\n");
    // Keep the request itself within budget: the latest part of the history matters most.
    const room = Math.floor(this.contextBudget() * 0.7);
    const text = transcript.length > room ? `[...]\n${transcript.slice(-room)}` : transcript;
    const result = await this.choice.provider.chat({
      model: this.choice.model,
      system: "You summarize a coding session so it can continue with less context. Be factual and concise.",
      messages: [{
        role: "user",
        content: `Summarize this conversation between a user and a coding agent, for the agent to continue from. Include: the user's requests (quote the latest one exactly), decisions made, files read or changed and what changed, commands run and their outcome, and what is left to do.\n\n${text}`,
      }],
      tools: [],
      onText: () => {},
      ...(signal ? { signal } : {}),
    });
    return result.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim() || "(no summary)";
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
        if (this.requestSize() > this.contextBudget()) await this.compact(false, signal);
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
        return fileTree(args.path ?? ".", 4, 500);
      }
      case "grep": {
        this.hooks.onEntry({ kind: "tool", text: `Searched for ${args.pattern}${args.path ? ` in ${args.path}` : ""}${args.glob ? ` (${args.glob})` : ""}` });
        return grep({
          pattern: String(args.pattern),
          ...(typeof args.path === "string" ? { path: args.path } : {}),
          ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
          ignoreCase: args.ignore_case === true,
          context: Number(args.context) || 0,
          filesOnly: args.files_only === true,
        });
      }
      case "glob": {
        this.hooks.onEntry({ kind: "tool", text: `Found files ${args.pattern}` });
        return globFiles(String(args.pattern), typeof args.path === "string" ? args.path : ".");
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
