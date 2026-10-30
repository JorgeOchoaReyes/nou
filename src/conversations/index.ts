import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { NOU_HOME } from "../config/index.js";
import type { ChatEntry } from "../agent/index.js";

/**
 * Conversations, saved per project after each reply so /resume (or `nou --continue`) can pick one back up:
 * the chat as you saw it, and what the engine needs to carry on (Nou's messages, Claude Code's session,
 * Codex's thread).
 */
export type Conversation = {
  id: string;
  /** The first thing you asked. */
  title: string;
  updated: number;
  engine: string;
  entries: ChatEntry[];
  /** The engine's own state, when it can pick the conversation back up itself. */
  state?: unknown;
};
export type ConversationSummary = Pick<Conversation, "id" | "title" | "updated" | "engine"> & { messages: number };

/** Kept per project: the oldest go once there are more. */
const KEEP = 50;
/** Chat entries saved per conversation (the latest ones). */
const MAX_ENTRIES = 500;

function folder(cwd = process.cwd()): string {
  const name = path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return path.join(NOU_HOME, "conversations", `${name}-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
}

export function saveConversation(conversation: Conversation) {
  const dir = folder();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = conversation.entries.slice(-MAX_ENTRIES);
    writeFileSync(path.join(dir, `${conversation.id}.json`), JSON.stringify({ ...conversation, entries }), { mode: 0o600 });
    const old = listConversations().slice(KEEP);
    for (const c of old) unlinkSync(path.join(dir, `${c.id}.json`));
  } catch {
    // Saving is a convenience: a read-only home shouldn't break the chat.
  }
}

/** This project's conversations, latest first. */
export function listConversations(): ConversationSummary[] {
  const dir = folder();
  if (!existsSync(dir)) return [];
  const out: ConversationSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const c: Conversation = JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
      out.push({ id: c.id, title: c.title, updated: c.updated, engine: c.engine, messages: c.entries.filter((e) => e.kind === "user").length });
    } catch {
      // a damaged file is skipped
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export function loadConversation(id: string): Conversation | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(path.join(folder(), `${id}.json`), "utf-8"));
  } catch {
    return null;
  }
}

/** "5m ago", "yesterday"... */
export function ago(time: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172_800) return "yesterday";
  return `${Math.floor(s / 86_400)}d ago`;
}
