import { mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

/**
 * Diagrams the agent draws (/visualize, or any reply with a diagram block): a Mermaid flowchart, read here and
 * drawn in the code view as boxes and arrows in text, so it works in every terminal; the browser shows the
 * same Mermaid fully rendered. Only flowcharts are drawn in text; others still open in the browser.
 */
export type Diagram = { title: string; source: string };

/** A diagram's tab in the code view is named like a file, under this prefix, so tabs work for it unchanged. */
export const DIAGRAM_TAB = "diagram:/";
export const isDiagramTab = (tab: string) => tab.startsWith(DIAGRAM_TAB);

export type Kind = "new" | "changed" | "removed" | "plain";
export type DiagramNode = { id: string; lines: string[]; kind: Kind; ref: { path: string; line?: number } | null };
export type DiagramEdge = { from: string; to: string; label: string; dotted: boolean };
export type Flowchart = { nodes: Map<string, DiagramNode>; edges: DiagramEdge[] };

/** A ```nou-diagram or ```mermaid block in a reply. */
const BLOCK = /(?:```|~~~)[ \t]*(?:nou-diagram|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:```|~~~)/g;

/** The diagrams in a reply, and the reply with each one replaced by a line saying where it opened. */
export function diagramsFromReply(text: string): { diagrams: Diagram[]; rest: string } {
  const diagrams: Diagram[] = [];
  const rest = text.replace(BLOCK, (_all, body: string) => {
    const diagram = { title: diagramTitle(body), source: body.trim() };
    diagrams.push(diagram);
    return `◈ Diagram: ${diagram.title} (in the code view · o opens it in the browser)`;
  });
  return { diagrams, rest: rest.trim() };
}

/** "%% title: X", Mermaid's "title: X" front matter, or a plain name. */
function diagramTitle(source: string): string {
  const m = /^\s*%%\s*title:\s*(.+)$/im.exec(source) ?? /^\s*title:\s*(.+)$/im.exec(source);
  return (m?.[1] ?? "diagram").trim().replace(/["']/g, "").slice(0, 40) || "diagram";
}

/** The note for the agent (every engine): when a picture helps, end the reply with a diagram block. */
export const DIAGRAM_NOTE = "When a picture helps explain something in this project (how parts connect, a flow, what a change touches), end your reply with a Mermaid flowchart in a fenced block marked nou-diagram; the user's editor draws it next to the code. Start with `%% title: <a few words>` and `flowchart TD`; keep it to about 15 nodes; give each node a short label with lines separated by ` · `, putting the file and line as path:line where it applies; for a change or PR, mark what it adds with NEW and what it changes with ± in the label. Example:\n```nou-diagram\n%% title: docs search\nflowchart TD\n  pages[\"docs/*.md\"] -->|read| build[\"build-index.ts NEW · scripts/build-index.ts:12\"]\n  build -->|writes| index[\"search-index.json\"]\n```";

/** The message /visualize sends. */
export function visualizePrompt(question: string): string {
  return `[Visualize] ${question}\n\nExplain this with a diagram. Read what you need (for a PR or changes, the diff), answer briefly, and end with a nou-diagram block as described. Don't change any files.`;
}

const NODE = /^([A-Za-z0-9_.$-]+)\s*(?:\[\[(.*?)\]\]|\[\((.*?)\)\]|\(\((.*?)\)\)|\[\/(.*?)\/\]|\[(.*?)\]|\((.*?)\)|\{\{(.*?)\}\}|\{(.*?)\}|>(.*?)\])?/;
const ARROW = /^\s*(-->|---|-\.->|-\.-|==>|===|--[ox]|<-->)\s*(?:\|([^|]*)\|)?\s*/;
const TEXT_ARROW = /^\s*--\s+([^-]+?)\s+-->\s*/;

/** Reads a Mermaid flowchart (flowchart/graph TD, LR...); null for anything else. */
export function parseFlowchart(source: string): Flowchart | null {
  const lines = source.split(/\r?\n|;/).map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  const head = lines.findIndex((l) => /^(flowchart|graph)\b/i.test(l));
  if (head < 0) return null;
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const node = (id: string, label?: string) => {
    const known = nodes.get(id);
    if (known && label === undefined) return known;
    const text = (label ?? known?.lines.join(" · ") ?? id).replace(/^"|"$/g, "").replace(/<br\s*\/?>/gi, " · ");
    const made = makeNode(id, text);
    nodes.set(id, made);
    return made;
  };
  for (const line of lines.slice(head + 1)) {
    if (/^(subgraph|end|classDef|class|style|linkStyle|click|direction|title:|---)\b/i.test(line)) continue;
    let rest = line;
    let previous: string | null = null;
    let pending: { label: string; dotted: boolean } | null = null;
    while (rest) {
      const m = NODE.exec(rest);
      if (!m) break;
      const label = m.slice(2).find((g) => g !== undefined);
      const id = node(m[1]!, label).id;
      if (previous && pending) edges.push({ from: previous, to: id, ...pending });
      previous = id;
      rest = rest.slice(m[0].length);
      // "A & B --> C": both start the edge; kept simple, the last one does.
      rest = rest.replace(/^\s*&\s*/, "");
      const arrow = ARROW.exec(rest);
      const worded = arrow ? null : TEXT_ARROW.exec(rest); // "A -- label --> B"
      if (!arrow && !worded) break;
      pending = { label: ((arrow ? arrow[2] : worded![1]) ?? "").trim().replace(/^"|"$/g, ""), dotted: !!arrow?.[1]?.includes(".") };
      rest = rest.slice((arrow ?? worded)![0].length);
    }
  }
  return nodes.size ? { nodes, edges } : null;
}

const REF = /([\w@.~/-]+\.[A-Za-z0-9]+)(?::(\d+))?/;

function makeNode(id: string, text: string): DiagramNode {
  const parts = text.split(/\s+·\s+|\n/).map((p) => p.trim()).filter(Boolean);
  const kind: Kind = /\bNEW\b|\(new\)/.test(text) ? "new" : /±|\bCHANGED\b|\(changed\)/.test(text) ? "changed" : /\bREMOVED\b|\bDELETED\b/.test(text) ? "removed" : "plain";
  // The file it's about: one with a line number first, then one with a folder, then any.
  const refs = [...text.matchAll(new RegExp(REF.source, "g"))].filter((m) => !/^\d+(\.\d+)+$/.test(m[1]!));
  const ref = refs.find((m) => m[2]) ?? refs.find((m) => m[1]!.includes("/")) ?? refs[0];
  return { id, lines: parts.length ? parts : [id], kind, ref: ref ? { path: ref[1]!, ...(ref[2] ? { line: Number(ref[2]) } : {}) } : null };
}

/** One drawn cell's look. */
export type Style = "edge" | "edgeLabel" | "border" | "text" | "title";
export type Cell = { ch: string; style: Style | null; node: string | null };
export type Drawn = { width: number; height: number; cells: Cell[][]; boxes: { id: string; x: number; y: number; w: number; h: number; kind: Kind }[] };

const MAX_TEXT = 28;
const H_GAP = 4;
const V_GAP = 3;

/** Breaks a node's lines to fit a box. */
function wrapLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > MAX_TEXT) {
      const cut = rest.lastIndexOf(" ", MAX_TEXT);
      const at = cut > 8 ? cut : MAX_TEXT;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    out.push(rest);
  }
  return out;
}

/**
 * Lays the flowchart out top to bottom in layers (Sugiyama-style): each node one below the lowest node pointing
 * at it, a node nothing points at just above what it feeds, edges that skip layers routed through invisible
 * waypoints so they pass between boxes, nodes kept under the ones they come from. Then draws boxes and arrows
 * into a grid of styled cells.
 */
export function drawFlowchart(chart: Flowchart): Drawn {
  const ids = [...chart.nodes.keys()];
  const into = new Map<string, string[]>(ids.map((id) => [id, []]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const edges = chart.edges.filter((e) => e.from !== e.to);
  for (const e of edges) {
    into.get(e.to)!.push(e.from);
    out.get(e.from)!.push(e.to);
  }
  // Layers by longest path from the sources; an edge back up a cycle is left out of the ordering.
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(0, ...into.get(id)!.filter((p) => !visiting.has(p) || layer.has(p)).map((p) => depth(p) + 1));
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  ids.forEach(depth);
  // A node nothing points at sits just above the first thing it feeds, not at the very top.
  for (const id of ids) {
    const below = out.get(id)!.map((c) => layer.get(c)!).filter((l) => l > layer.get(id)!);
    if (!into.get(id)!.length && below.length) layer.set(id, Math.min(...below) - 1);
  }

  type Box = { text: string[]; w: number; h: number; dummy: boolean };
  const size = new Map<string, Box>(ids.map((id) => {
    const text = wrapLines(chart.nodes.get(id)!.lines);
    return [id, { text, w: Math.max(10, ...text.map((t) => t.length)) + 4, h: text.length + 2, dummy: false }];
  }));
  // Edges down more than one layer go through a waypoint in each layer between; the label rides the first leg.
  type Leg = { from: string; to: string; label: string; last: boolean };
  const legs: Leg[] = [];
  const back: DiagramEdge[] = [];
  let waypoints = 0;
  for (const e of edges) {
    const a = layer.get(e.from)!;
    const b = layer.get(e.to)!;
    if (b <= a) {
      back.push(e);
      continue;
    }
    let from = e.from;
    for (let l = a + 1; l < b; l++) {
      const id = `\u0000wp${waypoints++}`;
      layer.set(id, l);
      size.set(id, { text: [], w: 1, h: 0, dummy: true });
      into.set(id, [from]);
      legs.push({ from, to: id, label: from === e.from ? e.label : "", last: false });
      from = id;
    }
    legs.push({ from, to: e.to, label: from === e.from ? e.label : "", last: true });
    into.set(e.to, into.get(e.to)!.map((p) => (p === e.from ? from : p)));
  }

  const layers: string[][] = [];
  for (const [id, l] of layer) (layers[l] ??= []).push(id);
  const pos = new Map<string, { x: number; y: number }>();
  const layerTop: number[] = [];
  const layerHeight: number[] = [];
  let y = 0;
  layers.forEach((row = [], l) => {
    // Under the middle of what points at it, in that order; then pushed apart so nothing overlaps.
    const want = (id: string) => {
      const parents = into.get(id)!.filter((p) => pos.has(p));
      if (!parents.length) return null;
      return Math.round(parents.reduce((sum, p) => sum + pos.get(p)!.x + Math.floor(size.get(p)!.w / 2), 0) / parents.length);
    };
    row.sort((a, b) => (want(a) ?? Infinity) - (want(b) ?? Infinity));
    let x = 0;
    for (const id of row) {
      const w = size.get(id)!.w;
      const centre = want(id);
      x = Math.max(x, centre === null ? x : centre - Math.floor(w / 2));
      pos.set(id, { x, y });
      x += w + (size.get(id)!.dummy ? 2 : H_GAP);
    }
    layerTop[l] = y;
    layerHeight[l] = Math.max(1, ...row.map((id) => size.get(id)!.h));
    y += layerHeight[l]! + V_GAP;
  });
  // A waypoint fills its layer's height, so a passing edge is one straight line through it.
  for (const [id, box] of size) if (box.dummy) box.h = layerHeight[layer.get(id)!]!;
  const minX = Math.min(...[...pos.values()].map((p) => p.x));
  for (const p of pos.values()) p.x -= minX - 1;
  const width = Math.max(...[...pos.keys()].map((id) => pos.get(id)!.x + size.get(id)!.w)) + 2;
  const height = Math.max(0, y - V_GAP) + 1;

  // Edges first (lines as directions per cell, joined into box-drawing characters), then boxes over them.
  const dirs: number[][] = Array.from({ length: height }, () => Array(width + 40).fill(0));
  const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;
  const mark = (x: number, yy: number, d: number) => {
    if (yy >= 0 && yy < height && x >= 0 && x < dirs[0]!.length) dirs[yy]![x]! |= d;
  };
  const vline = (x: number, y1: number, y2: number) => {
    for (let yy = Math.min(y1, y2); yy <= Math.max(y1, y2); yy++) {
      if (yy > Math.min(y1, y2)) mark(x, yy, UP);
      if (yy < Math.max(y1, y2)) mark(x, yy, DOWN);
    }
  };
  const hline = (yy: number, x1: number, x2: number) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      if (x > Math.min(x1, x2)) mark(x, yy, LEFT);
      if (x < Math.max(x1, x2)) mark(x, yy, RIGHT);
    }
  };
  const centre = (id: string) => pos.get(id)!.x + Math.floor(size.get(id)!.w / 2);
  const arrows: { x: number; y: number }[] = [];
  const labels: { x: number; y: number; text: string }[] = [];
  for (const leg of legs) {
    const a = pos.get(leg.from)!, sa = size.get(leg.from)!;
    const b = pos.get(leg.to)!;
    const sx = centre(leg.from);
    const tx = centre(leg.to);
    const sy = a.y + sa.h; // just under the source
    const ty = b.y - 1; // just over the target
    const turn = sy + 1;
    if (sa.dummy) vline(sx, a.y, sy);
    vline(sx, sy, turn);
    hline(turn, sx, tx);
    vline(tx, turn, size.get(leg.to)!.dummy ? b.y : ty);
    if (leg.last) arrows.push({ x: tx, y: ty });
    if (leg.label) labels.push({ x: sx, y: sy, text: leg.label });
  }
  for (const e of back) {
    // Back up (a cycle) or across: out of the source's side, round, and into the target's side.
    const a = pos.get(e.from)!, sa = size.get(e.from)!;
    const b = pos.get(e.to)!, sb = size.get(e.to)!;
    const side = Math.max(a.x + sa.w, b.x + sb.w) + 1;
    const sy = a.y + Math.floor(sa.h / 2);
    const ty = b.y + Math.floor(sb.h / 2);
    hline(sy, a.x + sa.w, side);
    vline(side, sy, ty);
    hline(ty, side, b.x + sb.w);
    arrows.push({ x: b.x + sb.w, y: ty });
    if (e.label) labels.push({ x: side, y: Math.floor((sy + ty) / 2), text: e.label });
  }
  const glyph = (d: number) => ["", "│", "│", "│", "─", "┘", "┐", "┤", "─", "└", "┌", "├", "─", "┴", "┬", "┼"][d] ?? " ";
  const wider = Math.max(width, ...labels.map((l) => l.x + l.text.length + 3));
  const cells: Cell[][] = Array.from({ length: height }, (_, yy) =>
    Array.from({ length: wider }, (_, x) => {
      const d = dirs[yy]![x] ?? 0;
      return d ? { ch: glyph(d), style: "edge" as Style, node: null } : { ch: " ", style: null, node: null };
    }));
  for (const a of arrows) {
    const sideways = (dirs[a.y]![a.x]! & (LEFT | RIGHT)) && !(dirs[a.y]![a.x]! & UP);
    cells[a.y]![a.x] = { ch: sideways ? "◀" : "▼", style: "edge", node: null };
  }
  // A label goes beside its line where it fits whole (right, else left), or not at all.
  const free = (x: number, yy: number, n: number) => x >= 0 && x + n <= wider && cells[yy]!.slice(x, x + n).every((c) => c.ch === " ");
  const inBox = (x: number, yy: number, n: number) => [...pos.keys()].some((id) => {
    const p = pos.get(id)!, s = size.get(id)!;
    return !s.dummy && yy >= p.y && yy < p.y + s.h && x < p.x + s.w && x + n > p.x;
  });
  for (const l of labels) {
    let text = l.text.length > 30 ? `${l.text.slice(0, 29)}…` : l.text;
    let spot = [l.x + 2, l.x - 1 - text.length].find((x) => free(x - 1, l.y, text.length + 2) && !inBox(x, l.y, text.length));
    if (spot === undefined) {
      // Short of room on the right: as much as fits there, if that's still worth reading.
      let room = 0;
      while (free(l.x + 1, l.y, room + 3) && !inBox(l.x + 2, l.y, room + 1) && room < text.length) room++;
      if (room < 8) continue;
      text = `${text.slice(0, room - 1)}…`;
      spot = l.x + 2;
    }
    [...text].forEach((ch, i) => (cells[l.y]![spot! + i] = { ch, style: "edgeLabel", node: null }));
  }
  const boxes: Drawn["boxes"] = [];
  for (const id of ids) {
    const { x, y: top } = pos.get(id)!;
    const { text, w, h } = size.get(id)!;
    const n = chart.nodes.get(id)!;
    boxes.push({ id, x, y: top, w, h, kind: n.kind });
    for (let yy = top; yy < top + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const edge = yy === top || yy === top + h - 1 || xx === x || xx === x + w - 1;
        const ch = edge
          ? yy === top ? (xx === x ? "┌" : xx === x + w - 1 ? "┐" : "─") : yy === top + h - 1 ? (xx === x ? "└" : xx === x + w - 1 ? "┘" : "─") : "│"
          : text[yy - top - 1]?.[xx - x - 2] ?? " ";
        cells[yy]![xx] = { ch, style: edge ? "border" : yy === top + 1 ? "title" : "text", node: id };
      }
    }
  }
  return { width: wider, height, cells, boxes };
}

/** A web page showing the diagram drawn by Mermaid itself (in the browser), saved under ~/.nou/diagrams. */
export function diagramPage(diagram: Diagram, dark: boolean): string {
  const dir = path.join(process.env.NOU_HOME ?? path.join(os.homedir(), ".nou"), "diagrams");
  mkdirSync(dir, { recursive: true });
  const slug = diagram.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "diagram";
  const file = path.join(dir, `${slug}.html`);
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  writeFileSync(file, `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(diagram.title)} · Nou</title>
<style>body{margin:0;padding:24px;font:15px system-ui,sans-serif;background:${dark ? "#1a1b26" : "#fff"};color:${dark ? "#c0caf5" : "#1f2335"}}h1{font-size:18px;font-weight:600}.mermaid{overflow:auto}</style>
</head><body><h1>${escape(diagram.title)}</h1>
<pre class="mermaid">${escape(diagram.source)}</pre>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: true, theme: "${dark ? "dark" : "default"}", securityLevel: "strict" });
</script></body></html>
`);
  return pathToFileURL(file).href;
}
