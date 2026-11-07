import { readFileSync, statSync } from "fs";
import path from "path";
import { newSessionId, type AgentHooks } from "../agent/index.js";
import { isInProject, toRelative, type FileChange } from "../commands/index.js";
import type { ModelChoice } from "../providers/index.js";
import type { Engine, EngineId, EngineOptions } from "./types.js";

function readOrNull(filePath: string): string | null {
  try {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return null;
  }
}

/** A file a shell command reads, and the lines when it reads part of it (see readsInCommand). */
export type CommandRead = { path: string; line?: number; to?: number };

/**
 * The files a shell command reads, so follow mode can show them: engines like Codex read with `sed -n
 * '10,80p' f`, `cat f`, `nl -ba f`, `head -n 40 f` instead of a read tool. Only files that exist in the
 * project count; anything it can't make sense of is no read.
 */
export function readsInCommand(command: string): CommandRead[] {
  // Codex runs `bash -lc '<script>'`: look inside the quotes.
  const wrapped = command.match(/^\S*(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
  const script = wrapped ? wrapped[2]! : command;
  const reads: CommandRead[] = [];
  for (const part of script.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const words = (part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
    const [tool, ...args] = words;
    if (!tool) continue;
    const files = args.filter((a) => !a.startsWith("-") && /[./]|\w\.\w/.test(a));
    let range: { line?: number; to?: number } = {};
    if (tool === "sed" && args.includes("-n")) {
      const m = args.join(" ").match(/(\d+)\s*,\s*(\d+)\s*p/) ?? args.join(" ").match(/(\d+)p/);
      if (!m) continue;
      range = { line: Number(m[1]), to: Number(m[2] ?? m[1]) };
      files.splice(0, files.length, ...files.filter((f) => !/^\d+(,\d+)?p$/.test(f)));
      // `nl -ba f | sed -n '5,9p'`: the lines are of the file read just before it in the pipe.
      const last = reads.at(-1);
      if (!files.length && last && last.line === undefined) Object.assign(last, range);
    } else if (tool === "head") {
      const n = Number(args.join(" ").match(/-n\s*(\d+)|-(\d+)/)?.slice(1).find(Boolean) ?? 10);
      range = { line: 1, to: n };
    } else if (!["cat", "nl", "bat", "less", "more", "tail"].includes(tool)) continue;
    for (const file of files) {
      try {
        if (!statSync(path.resolve(process.cwd(), file)).isFile() || !isInProject(file)) continue;
      } catch {
        continue;
      }
      reads.push({ path: toRelative(file), ...range });
    }
  }
  return reads;
}

/** Replaces `oldText` with `newText`, as edit tools do; null if it isn't there (the tool will fail on its own). */
export function replaceIn(text: string, oldText: string, newText: string, all = false): string | null {
  if (!oldText || !text.includes(oldText)) return null;
  return all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
}

/**
 * Lets an engine that edits files itself still go through Nou: approve() shows the proposed diff (or asks,
 * when the engine's edit can't be previewed) and remembers the file as it was; applied() reads what the
 * engine actually wrote, records it for undo and returns any problems it introduced.
 */
export class ChangeTracker {
  private before = new Map<string, string | null>();

  constructor(private hooks: AgentHooks, private turnId: () => string) {}

  /** `after` is the file's proposed new content, or undefined when it can't be worked out in advance. */
  async approve(filePath: string, after: string | undefined, tool: string): Promise<boolean> {
    const rel = toRelative(filePath);
    if (!isInProject(filePath)) return this.hooks.approve({ kind: "tool", name: tool, args: { path: filePath } });
    const before = readOrNull(rel);
    if (after === undefined) {
      const ok = await this.hooks.approve({ kind: "tool", name: tool, args: { path: rel } });
      if (ok) this.before.set(rel, before);
      return ok;
    }
    const change: FileChange = { path: rel, before: before ?? "", after, isNew: before === null };
    this.hooks.onChange(change, "pending", this.turnId());
    const ok = await this.hooks.approve({ kind: "change", change });
    if (ok) this.before.set(rel, before);
    else {
      this.hooks.onChange(change, "rejected", this.turnId());
      this.hooks.onEntry({ kind: "tool", text: `Rejected edit to ${rel}` });
    }
    return ok;
  }

  /** For engines that edit without asking: remember files as they are now, so changes can be shown and undone. */
  remember(files: Iterable<string>) {
    for (const file of files) {
      const rel = toRelative(file);
      if (!this.before.has(rel)) this.before.set(rel, readOrNull(rel));
    }
  }

  /**
   * After the engine wrote the file: records the change and returns problems it introduced, if any.
   * `created` marks a file the engine says it added, which won't have been remembered beforehand.
   */
  async applied(filePath: string, created = false): Promise<string | null> {
    const rel = toRelative(filePath);
    if (!this.before.has(rel) && !created) return null;
    const before = this.before.get(rel) ?? null;
    this.before.delete(rel);
    const after = readOrNull(rel);
    if (after === null || after === before) return null;
    const change: FileChange = { path: rel, before: before ?? "", after, isNew: before === null };
    this.hooks.onChange(change, "applied", this.turnId());
    this.hooks.onEntry({ kind: "tool", text: `${change.isNew ? "Created" : "Edited"} ${rel}` });
    const problems = await this.hooks.checkChange?.(change).catch(() => null);
    if (problems) this.hooks.onEntry({ kind: "error", text: `New problems in ${rel}:\n${problems}` });
    return problems ?? null;
  }

  clear() {
    this.before.clear();
  }
}

/** What engines that run their own agent loop share: turn bookkeeping, notes, cancelling and error reporting. */
export abstract class ExternalEngine implements Engine {
  abstract readonly id: EngineId;
  turn = 0;
  readonly session = newSessionId();
  protected extras: string[] = [];
  protected effort: string | undefined;
  protected notes: string[] = [];
  protected controller: AbortController | null = null;
  protected tracker: ChangeTracker;

  constructor(public choice: ModelChoice, protected hooks: AgentHooks, protected label: string) {
    this.tracker = new ChangeTracker(hooks, () => this.turnId);
  }

  get turnId(): string {
    return `${this.session}:${this.turn}`;
  }

  configure(options: EngineOptions) {
    if (options.extras) this.extras = options.extras;
    if (options.effort) this.effort = options.effort;
  }

  setModel(choice: ModelChoice) {
    this.choice = choice;
    this.resetConversation();
  }

  clear() {
    this.notes = [];
    this.resetConversation();
  }

  note(text: string) {
    this.notes.push(text);
  }

  cancel() {
    this.controller?.abort();
  }

  async send(text: string, context?: string) {
    this.turn++;
    const notes = this.notes.length ? `${this.notes.map((n) => `[Note: ${n}]`).join("\n")}\n\n` : "";
    this.notes = [];
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.hooks.onBusy(`Working with ${this.label}...`);
    try {
      await this.run(`${notes}${text}${context ? `\n\n${context}` : ""}`, signal);
    } catch (error: any) {
      if (signal.aborted) this.hooks.onEntry({ kind: "info", text: "Cancelled." });
      else this.hooks.onEntry({ kind: "error", text: `${this.label}: ${error.message}` });
    } finally {
      this.hooks.onStream("");
      this.tracker.clear();
      this.controller = null;
      this.hooks.onBusy(null);
    }
  }

  /** Runs one user message through the engine, reporting through this.hooks. */
  protected abstract run(prompt: string, signal: AbortSignal): Promise<void>;
  /** Forgets the conversation (the next message starts a new one). */
  protected abstract resetConversation(): void;
}
