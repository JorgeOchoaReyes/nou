import type { Kind } from "../diagram/index.js";
import { REPORT_NOTE, reportFromReply } from "./agents.js";

/**
 * Handoffs between the conversation tabs of a workspace: each chat is one agent with one job, and when its turn
 * ends its reply is handed to the next chat, like the nodes of a flow. A chat can have a role (its standing
 * instructions), several next chats with a condition each (the agent says which one with a ```nou-next block),
 * and can wait for your OK before handing off.
 */
export type FlowLink = { to: string; when?: string };
export type FlowNode = { role?: string; links: FlowLink[]; ask?: boolean };
/** A chat as the flow sees it: its tab id, the name it goes by, and what it's doing. */
export type FlowTab = { id: string; name: string; state: "idle" | "busy" | "waiting"; engine: string };
/** A handoff waiting for your OK (or for you to say where, when the agent didn't). */
export type PendingHandoff = { from: string; to: string | null; text: string };

/** "done" in a nou-next block: the flow stops here. */
export const DONE = "done";

const NEXT_BLOCK = /(?:```|~~~)[ \t]*nou-next[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:```|~~~)/;

/** The next chat a reply names (```nou-next block), and the reply without the block. */
export function nextFromReply(text: string): { next: string | null; rest: string } {
  const m = NEXT_BLOCK.exec(text);
  if (!m) return { next: null, rest: text };
  const next = m[1]!.trim().split(/\r?\n/)[0]!.trim().replace(/^["'`]|["'`]$/g, "") || null;
  return { next, rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

/** A tab named by its number (1-based, as /tab counts them), its name, or the start of its name. */
export function findTab(tabs: FlowTab[], word: string): FlowTab | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  if (/^\d+$/.test(w)) return tabs[Number(w) - 1] ?? null;
  return tabs.find((t) => t.name.toLowerCase() === w) ?? tabs.find((t) => t.name.toLowerCase().startsWith(w)) ?? null;
}

/**
 * Where a finished turn goes: one link without a condition always goes there; with several, the one the reply
 * named (by the chat's name or its condition). `null` with links means the agent didn't say; DONE ends it.
 */
export function pickLink(node: FlowNode | undefined, tabs: FlowTab[], named: string | null): string | typeof DONE | null {
  const links = (node?.links ?? []).filter((l) => tabs.some((t) => t.id === l.to));
  if (!links.length) return DONE;
  if (named && /^(done|stop|end|finished)$/i.test(named.trim())) return DONE;
  if (named) {
    const n = named.trim().toLowerCase();
    const byName = links.find((l) => tabs.find((t) => t.id === l.to)?.name.toLowerCase() === n);
    const byWhen = links.find((l) => l.when && l.when.toLowerCase() === n);
    const loose = links.find((l) => n.includes(tabs.find((t) => t.id === l.to)!.name.toLowerCase()));
    const hit = byName ?? byWhen ?? loose;
    if (hit) return hit.to;
  }
  if (links.length === 1 && !links[0]!.when) return links[0]!.to;
  return null;
}

/** What's added to each message a chat in a flow gets: its role, and where its reply goes next. */
export function flowNote(node: FlowNode | undefined, tabs: FlowTab[]): string {
  if (!node) return "";
  const parts: string[] = [];
  if (node.role) parts.push(`Your role in this workspace: ${node.role}`);
  const links = node.links.filter((l) => tabs.some((t) => t.id === l.to));
  const name = (id: string) => tabs.find((t) => t.id === id)!.name;
  if (links.length === 1 && !links[0]!.when) {
    parts.push(`When you finish, your report is handed to "${name(links[0]!.to)}", another agent, as its next task. If nothing more is needed from it, put a fenced block marked nou-next containing just "done" after the report.`);
  } else if (links.length) {
    const options = links.map((l) => `${name(l.to)}${l.when ? ` (when ${l.when})` : ""}`).join("; ");
    parts.push(`When you finish, your report is handed to one of these agents as its next task: ${options}. After the report, put a fenced block marked nou-next containing just the name of the one it goes to, or done if nothing more is needed. Example:\n\`\`\`nou-next\n${name(links[0]!.to)}\n\`\`\``);
  }
  // Every chat with a job or a next step ends the same way: a short report, which is what's handed on.
  if (parts.length) parts.push(REPORT_NOTE);
  return parts.join("\n\n");
}

/** What the next chat gets: who it's from and their report (the whole reply when it didn't write one). */
export function handoffText(fromName: string, reply: string): string {
  return `↘ From ${fromName}:\n\n${(reportFromReply(reply) ?? reply).trim()}`;
}

/** The workspace's chats and handoffs as a flowchart for the code view: a box per chat, an arrow per handoff. */
export function sessionsDiagram(tabs: FlowTab[], nodes: Map<string, FlowNode>, pending: PendingHandoff[], active: string): { source: string; kinds: Record<string, Kind> } {
  const id = (tabId: string) => `t${tabId}`;
  const label = (s: string) => s.replace(/["`|]/g, "'").replace(/\s+/g, " ").trim();
  const lines = ["%% title: sessions", "flowchart TD"];
  const kinds: Record<string, Kind> = {};
  for (const t of tabs) {
    const node = nodes.get(t.id);
    const waits = pending.some((p) => p.from === t.id);
    const state = t.state === "busy" ? "● working" : t.state === "waiting" ? "◆ needs your OK" : waits ? "◆ handoff waits" : "○ idle";
    const role = node?.role ? label(node.role.length > 24 ? `${node.role.slice(0, 23)}…` : node.role) : null;
    // Two or three lines a box: who and what it's doing, its engine, its job.
    const parts = [`${label(t.name)}${t.id === active ? " ◂" : ""}  ${state}`, ...(role ? [role] : []), t.engine];
    lines.push(`  ${id(t.id)}["${parts.join(" · ")}"]`);
    kinds[id(t.id)] = t.state === "busy" ? "changed" : t.state === "waiting" || waits ? "removed" : "plain";
  }
  for (const t of tabs) {
    for (const l of nodes.get(t.id)?.links ?? []) {
      if (!tabs.some((x) => x.id === l.to)) continue;
      const tag = [l.when ? label(l.when) : "", nodes.get(t.id)?.ask ? "ask me" : ""].filter(Boolean).join(" · ");
      lines.push(`  ${id(t.id)} -->${tag ? `|${tag}|` : ""} ${id(l.to)}`);
    }
  }
  return { source: lines.join("\n"), kinds };
}

/** The tab id a box in the sessions view stands for. */
export const tabOfNode = (nodeId: string) => (nodeId.startsWith("t") ? nodeId.slice(1) : null);
