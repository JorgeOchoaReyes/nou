import { randomUUID } from "crypto";
import { existsSync, statSync } from "fs";
import { toolDefs } from "../tools/index.js";
import {
  applyChange,
  capOutput,
  fileTree,
  isInProject,
  proposeEdit,
  proposeEdits,
  proposeWrite,
  readForModel,
  runCommand,
  toRelative,
  type FileChange,
} from "../commands/index.js";
import { describe, keyHint, type ChatMessage, type ModelChoice, type ToolCall, type ToolDef } from "../providers/index.js";
import { newCallId } from "../providers/ids.js";
import type { Engine, EngineOptions } from "../engines/types.js";
import { globFiles, grep } from "../search/index.js";

/** Model requests per user message before stopping; real tasks (explore, edit, test, fix) take a few dozen. */
const MAX_STEPS = 60;
/** Tries per model request when it fails for a passing reason (see withRetries). */
const RETRIES = 6;
/** Errors worth retrying: overloaded, rate limited, a server error, a dropped or timed-out connection. */
function transient(error: any): boolean {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  return transientMessage(String(error?.message ?? error));
}

/** Whether an error's text reads as a passing problem (a dropped stream, a busy or failing server). */
export function transientMessage(text: string): boolean {
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Invalid URL|api key|unauthori[sz]ed|\b40[13]\b/i.test(text)) return false;
  return /overloaded|rate.?limit|too many requests|ECONNRESET|socket hang up|ETIMEDOUT|timed? ?out|EPIPE|network|premature close|terminated|disconnected|server had an error|internal server error|service unavailable|bad gateway|try again|\b(429|5\d\d)\b/i.test(text);
}

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
  /** A file the agent read; `line`..`to` when it read only part of it. */
  onRead(path: string, line?: number, to?: number): void;
  /** Shows a file in the user's code view, scrolled to `line` with `line`..`to` highlighted. */
  onOpen?(path: string, line?: number, to?: number): void;
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

- Make independent calls together: several reads or searches in one response run at the same time.
- Use grep, glob and read_file to look around, not run_command with grep, find or cat. Several edits to one file go in one multi_edit.
- If an edit fails twice, read the file again before the next try.
- For work with three or more steps, keep a plan with update_plan and update it as you go.
- Don't commit, push, install packages or delete files unless the user asked. Don't add comments the code didn't need.
- Before saying something works, check it (run the tests or the code). If you couldn't, say so.
- When the user asks where something is, or to show, open or find something, search for it (grep, glob), read enough to be sure, then call open_file on the exact place (with line and end_line) so it opens in their code view, and answer in a sentence or two with path:line.
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
    // A different system prompt or tool list (an MCP server connected, a plugin switched) changes what the
    // earlier thinking was written against: newer Claude models reject replaying it, so it's dropped.
    const toolsChanged = options.extraTools && options.extraTools.map((t) => t.definition.name).join() !== this.extraTools.map((t) => t.definition.name).join();
    if (this.messages.length && ((options.system !== undefined && options.system !== this.system) || toolsChanged)) this.forgetThinking();
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

  /** Forgets the last message you sent and everything after it, as if it was never sent. */
  retractLast(): boolean {
    const at = this.messages.findLastIndex((m) => m.role === "user");
    if (at < 0) return false;
    this.messages = this.messages.slice(0, at);
    return true;
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
    if (trimmed) this.forgetThinking();
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
    this.forgetThinking();
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
   * Drops Claude's thinking blocks from the history. Newer Claude models reject a conversation whose
   * earlier turns were edited while it still carries their thinking blocks (they're tied to the exact
   * history they were written in), and trimming or summarizing is such an edit. Without them the model
   * carries on from the visible text and tool calls, which is what the trimmed history holds anyway.
   */
  private forgetThinking() {
    this.messages = this.messages.map((m) => {
      if (m.role !== "assistant" || m.raw?.provider !== "anthropic" || !Array.isArray(m.raw.data)) return m;
      const kept = (m.raw.data as { type: string }[]).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (kept.length === m.raw.data.length) return m;
      if (kept.length) return { ...m, raw: { ...m.raw, data: kept } };
      const plain = { ...m };
      delete plain.raw;
      return plain;
    });
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
      let cutOff = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.requestSize() > this.contextBudget()) await this.compact(false, signal);
        this.hooks.onBusy(`Pondering with ${describe(this.choice)}...`);
        let streamed = "";
        let thought = "";
        const result = await this.withRetries(signal, () => {
          streamed = "";
          thought = "";
          return this.choice.provider.chat({
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
            // Its thinking shows on the one-line progress (the latest of it), so the chat doesn't jump.
            onThinking: (delta) => {
              thought = (thought + delta).slice(-400);
              const latest = thought.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
              if (latest) this.hooks.onBusy(`Thinking: ${latest.length > 90 ? `…${latest.slice(-89)}` : latest}`);
            },
          });
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
          // The reply ran out of room mid tool call (usually a whole file in one write): tell the model and
          // let it try in smaller pieces, a couple of times, before giving up.
          if (++cutOff > 2) {
            this.hooks.onEntry({ kind: "error", text: "The response was cut off before its tool call finished, again. Try asking for a smaller change." });
            this.dropUnansweredCalls();
            return;
          }
          for (const call of result.toolCalls) {
            this.messages.push({ role: "tool", callId: call.id, name: call.name, isError: true,
              content: "Not run: your response hit the output limit before this call was complete. Make the change in smaller steps (edit_file or multi_edit with only the lines that change, not the whole file)." });
          }
          continue;
        }
        if (result.toolCalls.length === 0) return;

        // Calls that only look (reads, searches) run together; the rest run one at a time, in order,
        // since they may ask you first or change what a later call sees. Results keep the calls' order.
        const calls = result.toolCalls;
        for (let i = 0; i < calls.length && !signal.aborted;) {
          let j = i + 1;
          if (this.onlyLooks(calls[i]!)) while (j < calls.length && this.onlyLooks(calls[j]!)) j++;
          const batch = calls.slice(i, j);
          this.hooks.onBusy(batch.length > 1 ? `Running ${batch.length} tools...` : `Running ${batch[0]!.name}...`);
          const outputs = await Promise.all(batch.map(async (call) => {
            const problem = invalidArgs(call, this.tools);
            return problem ? { error: `Error: ${problem}` } : { output: capOutput(await this.runTool(call)) };
          }));
          batch.forEach((call, k) => {
            const out = outputs[k]!;
            this.messages.push({
              role: "tool",
              callId: call.id,
              name: call.name,
              content: "error" in out ? out.error! : out.output!,
              ...("error" in out ? { isError: true } : {}),
            });
          });
          i = j;
        }
        if (signal.aborted) throw new Error("aborted");
      }
      this.hooks.onEntry({ kind: "error", text: `Paused after ${MAX_STEPS} steps so it doesn't run away. Say "continue" to let it carry on.` });
    } catch (error: any) {
      this.hooks.onStream("");
      if (signal.aborted) {
        this.hooks.onEntry({ kind: "info", text: "Cancelled." });
      } else {
        const hint = keyHint(this.choice.provider, String(error.message));
        this.hooks.onEntry({ kind: "error", text: `${describe(this.choice)}: ${error.message}${hint ? `\n${hint}` : ""}` });
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

  /**
   * Runs a model request again when it failed for a passing reason (overloaded, rate limited, a server
   * error, a dropped connection), waiting longer each time. Setup problems (a bad key, a URL that doesn't
   * answer) fail straight away: waiting won't fix them, and the app shows where to.
   */
  private async withRetries<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request();
      } catch (error: any) {
        if (signal.aborted || attempt >= RETRIES || !transient(error)) throw error;
        const after = Number(error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"]);
        const wait = Math.min(30_000, after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1) + Math.random() * 500);
        this.hooks.onStream("");
        this.hooks.onBusy(`${describe(this.choice)}: ${String(error?.message ?? error).slice(0, 60)}. Retrying in ${Math.ceil(wait / 1000)}s (${attempt}/${RETRIES - 1})...`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (signal.aborted) throw error;
      }
    }
  }

  /** Tools that only read, which can run alongside each other. */
  private onlyLooks(call: ToolCall): boolean {
    if (["grep", "glob", "list_files", "get_file_tree"].includes(call.name)) return true;
    if (call.name === "read_file") return typeof call.args.path === "string" && isInProject(call.args.path);
    return this.extraTools.some((t) => t.definition.name === call.name && t.readOnly);
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
          const from = Number(args.offset) > 1 ? Math.floor(Number(args.offset)) : undefined;
          const count = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
          this.hooks.onRead(toRelative(args.path), from ?? (count ? 1 : undefined), count ? (from ?? 1) + count - 1 : undefined);
        }
        this.hooks.onEntry({ kind: "tool", text: `Read ${args.path}` });
        return await readForModel(args.path, args.offset, args.limit);
      }
      case "open_file": {
        const file = toRelative(String(args.path));
        if (!isInProject(file)) return "Error: only files in the project can be shown.";
        if (!existsSync(file) || !statSync(file).isFile()) return `Error: ${file} is not a file. Find it with glob first.`;
        const line = Number(args.line) > 0 ? Math.floor(Number(args.line)) : undefined;
        const to = line && Number(args.end_line) >= line ? Math.floor(Number(args.end_line)) : line;
        this.hooks.onOpen?.(file, line, to);
        this.hooks.onEntry({ kind: "tool", text: `Opened ${file}${line ? `:${line}${to && to !== line ? `-${to}` : ""}` : ""}` });
        return this.hooks.onOpen ? "It is now open in the user's code view." : "This interface can't show files; give the user the path instead.";
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
      case "multi_edit":
      case "write_file": {
        if (name === "multi_edit" && (!Array.isArray(args.edits) || !args.edits.length)) return "Error: edits must be a list of {old_string, new_string}.";
        const change = name === "edit_file"
          ? await proposeEdit(args.path, args.old_string, args.new_string, args.replace_all === true)
          : name === "multi_edit" ? await proposeEdits(args.path, args.edits) : await proposeWrite(args.path, args.content ?? "");
        return await this.reviewChange(change);
      }
      case "update_plan": {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const mark = { done: "✓", in_progress: "▸", pending: "○" } as Record<string, string>;
        this.hooks.onEntry({ kind: "tool", text: `Plan:\n${steps.map((st: any) => `${mark[st.status] ?? "○"} ${st.step}`).join("\n")}` });
        return "Plan updated.";
      }
      case "run_command": {
        const ok = await this.hooks.approve({ kind: "command", command: args.command });
        if (!ok) {
          this.hooks.onEntry({ kind: "tool", text: `Denied: ${args.command}` });
          return "User denied permission to run this command.";
        }
        this.hooks.onEntry({ kind: "tool", text: `Ran: ${args.command}` });
        // Timeouts are in seconds; a model that sends milliseconds still gets a sensible limit.
        const seconds = Number(args.timeout) > 0 ? Number(args.timeout) : 0;
        const output = await runCommand(args.command, seconds ? (seconds > 3600 ? seconds : seconds * 1000) : undefined, this.controller?.signal);
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
    this.hooks.onEntry({ kind: "tool", text: result });
    if (result.startsWith("Failed")) {
      this.hooks.onChange(change, "rejected", this.turnId);
      return result;
    }
    this.hooks.onChange(change, "applied", this.turnId);
    this.hooks.onBusy(`Checking ${change.path} for problems...`);
    const problems = await this.hooks.checkChange?.(change).catch(() => null);
    if (problems) this.hooks.onEntry({ kind: "error", text: `New problems in ${change.path}:\n${problems}` });
    return problems ? `${result}\n\nThis edit introduced problems; fix them:\n${problems}` : result;
  }
}
