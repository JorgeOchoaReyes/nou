import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import os from "os";
import path from "path";
import type { ChatEntry } from "../agent/index.js";

/**
 * Sessions started in Claude Code's or Codex's own CLI in this folder, so /resume can pick them up in Nou
 * too: Claude Code keeps them in ~/.claude/projects/<folder>/<id>.jsonl, Codex in
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (with the folder in its first line).
 */
export type ExternalSession = {
  id: string;
  engine: "claude-code" | "codex";
  title: string;
  updated: number;
  messages: number;
  file: string;
};

/** Files looked at per tool: the newest ones. */
const SCAN = 300;

const claudeDir = (home: string) => process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
const codexDir = (home: string) => process.env.CODEX_HOME ?? path.join(home, ".codex");

function jsonLines(file: string, limit = Infinity): any[] {
  const out: any[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line being written
    }
  }
  return out;
}

/** The start of a file, for the line that says which folder a Codex session ran in. */
function head(file: string, bytes = 8192): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Plain text from a message's content (a string, or parts with text). */
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => typeof p?.text === "string" && /^(text|input_text|output_text)$/.test(p.type ?? "text")).map((p) => p.text).join("\n");
}

/** What the tools add on their own (context blocks, command echoes): not something you typed. */
const injected = (text: string) => /^\s*<(environment_context|user_instructions|command-|local-command|system-reminder)/.test(text) || text.startsWith("Caveat:");

const titleOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);

/** Claude Code's sessions for this folder. */
function claudeSessions(home: string, cwd: string): ExternalSession[] {
  const dir = path.join(claudeDir(home), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  const out: ExternalSession[] = [];
  for (const file of newest(files)) {
    const said = claudeEntries(file);
    const first = said.find((e) => e.kind === "user");
    if (!first) continue;
    out.push({ id: path.basename(file, ".jsonl"), engine: "claude-code", title: titleOf(first.text), updated: statSync(file).mtimeMs, messages: said.filter((e) => e.kind === "user").length, file });
  }
  return out;
}

function claudeEntries(file: string): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const line of jsonLines(file)) {
    if (line.isSidechain || line.isMeta) continue;
    if (line.type === "user" && line.message?.role === "user") {
      const text = textOf(line.message.content);
      if (text.trim() && !injected(text)) out.push({ kind: "user", text: text.trim() });
    } else if (line.type === "assistant") {
      const text = textOf(line.message?.content);
      if (text.trim()) out.push({ kind: "assistant", text: text.trim() });
    }
  }
  return out;
}

/** Codex's sessions for this folder (it keeps them all in one tree, by date). */
function codexSessions(home: string, cwd: string): ExternalSession[] {
  const root = path.join(codexDir(home), "sessions");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort().reverse()) {
      if (files.length >= SCAN) return;
      const full = path.join(dir, name);
      if (depth < 3) walk(full, depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(full);
    }
  };
  try {
    walk(root, 0);
  } catch {
    return [];
  }
  const out: ExternalSession[] = [];
  for (const file of files) {
    let meta: any;
    try {
      meta = JSON.parse(head(file).split("\n")[0]!);
    } catch {
      continue;
    }
    const payload = meta?.type === "session_meta" ? meta.payload : null;
    if (!payload?.id || path.resolve(payload.cwd ?? "") !== path.resolve(cwd)) continue;
    const said = codexEntries(file);
    const first = said.find((e) => e.kind === "user");
    if (!first) continue;
    out.push({ id: payload.id, engine: "codex", title: titleOf(first.text), updated: statSync(file).mtimeMs, messages: said.filter((e) => e.kind === "user").length, file });
  }
  return out;
}

function codexEntries(file: string): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const line of jsonLines(file)) {
    const p = line.type === "response_item" ? line.payload : null;
    if (p?.type !== "message") continue;
    const text = textOf(p.content).trim();
    if (!text || injected(text)) continue;
    if (p.role === "user") out.push({ kind: "user", text });
    else if (p.role === "assistant") out.push({ kind: "assistant", text });
  }
  return out;
}

function newest(files: string[]): string[] {
  return files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, SCAN).map((x) => x.f);
}

/** Claude Code's and Codex's own sessions in this folder, latest first. */
export function externalSessions(home = os.homedir(), cwd = process.cwd()): ExternalSession[] {
  const out: ExternalSession[] = [];
  for (const read of [claudeSessions, codexSessions]) {
    try {
      out.push(...read(home, cwd));
    } catch {
      // a tool's files we can't read: skip them
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** The chat of an external session, to show when it's resumed. */
export function externalEntries(session: ExternalSession): ChatEntry[] {
  return session.engine === "claude-code" ? claudeEntries(session.file) : codexEntries(session.file);
}
