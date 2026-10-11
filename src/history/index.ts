import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { applyPatch, structuredPatch } from "diff";
import { NOU_HOME } from "../config/index.js";

/** One file change. `null` content means the file didn't exist (before) or was removed (after). */
export type Checkpoint = {
  id: number;
  path: string;
  before: string | null;
  after: string | null;
  source: "nou" | "you";
  /** Chat turn that produced it (Nou's changes only). */
  turn: number;
  time: number;
  undone?: boolean;
};

export type UndoResult = { ok: true; path: string; merged: boolean } | { ok: false; path: string; reason: string };

const MAX_CHECKPOINTS = 300;
const MAX_FILE_BYTES = 1_000_000;

function readOrNull(file: string): string | null {
  try {
    return readFileSync(path.resolve(process.cwd(), file), "utf-8");
  } catch {
    return null;
  }
}

/** Every change made during and across sessions, so edits can be undone safely. */
export class Timeline {
  private items: Checkpoint[] = [];
  private nextId = 1;
  private file: string;

  constructor(private onUpdate: () => void = () => {}) {
    const key = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16);
    this.file = path.join(NOU_HOME, "history", `${key}.json`);
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf-8"));
      this.items = Array.isArray(saved.items) ? saved.items : [];
      this.nextId = (this.items.at(-1)?.id ?? 0) + 1;
    } catch {
      // first run in this project
    }
  }

  get all(): readonly Checkpoint[] {
    return this.items;
  }

  record(entry: Omit<Checkpoint, "id" | "time">): Checkpoint | null {
    if (entry.before === entry.after) return null;
    if ((entry.before?.length ?? 0) > MAX_FILE_BYTES || (entry.after?.length ?? 0) > MAX_FILE_BYTES) return null;
    const checkpoint = { ...entry, id: this.nextId++, time: Date.now() };
    this.items.push(checkpoint);
    if (this.items.length > MAX_CHECKPOINTS) this.items.splice(0, this.items.length - MAX_CHECKPOINTS);
    this.save();
    return checkpoint;
  }

  /** Nou's most recent change that hasn't been undone. */
  lastNouChange(): Checkpoint | undefined {
    return [...this.items].reverse().find((c) => c.source === "nou" && !c.undone);
  }

  /** All of Nou's live changes from its most recent turn, newest first. */
  lastTurn(): Checkpoint[] {
    const last = this.lastNouChange();
    if (!last) return [];
    return this.items.filter((c) => c.source === "nou" && !c.undone && c.turn === last.turn).reverse();
  }

  /**
   * Reverts one checkpoint. If the file changed since, only Nou's part is reversed (patch merge);
   * if that conflicts, nothing is written.
   */
  undo(checkpoint: Checkpoint): UndoResult {
    const full = path.resolve(process.cwd(), checkpoint.path);
    const current = readOrNull(checkpoint.path);
    let target: string | null;
    let merged = false;

    if (current === checkpoint.after) {
      target = checkpoint.before;
    } else if (current !== null && checkpoint.after !== null && checkpoint.before !== null) {
      const eol = current.includes("\r\n") ? "\r\n" : "\n";
      const reverse = structuredPatch("f", "f", checkpoint.after.replace(/\r\n/g, "\n"), checkpoint.before.replace(/\r\n/g, "\n"));
      const result = applyPatch(current.replace(/\r\n/g, "\n"), reverse, { fuzzFactor: 2 });
      if (result === false) {
        return { ok: false, path: checkpoint.path, reason: "the file changed since in ways that overlap Nou's edit" };
      }
      target = result.replace(/\n/g, eol);
      merged = true;
    } else {
      return { ok: false, path: checkpoint.path, reason: "the file was created, removed or replaced since" };
    }

    try {
      if (target === null) rmSync(full, { force: true });
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, target, "utf-8");
      }
    } catch (error: any) {
      return { ok: false, path: checkpoint.path, reason: error.message };
    }
    checkpoint.undone = true;
    this.record({ path: checkpoint.path, before: current, after: target, source: "you", turn: checkpoint.turn });
    this.save();
    return { ok: true, path: checkpoint.path, merged };
  }

  private save() {
    try {
      if (!existsSync(path.dirname(this.file))) mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ cwd: process.cwd(), items: this.items }));
    } catch {
      // history is best effort
    }
    this.onUpdate();
  }
}
