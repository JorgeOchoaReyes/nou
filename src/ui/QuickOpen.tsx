import { useMemo, useState } from "react";
import { readdirSync } from "fs";
import path from "path";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { IGNORED } from "../commands/index.js";
import { C, fileIcon } from "./theme.js";

export function listAllFiles(limit = 5000): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const rel = dir === "." ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk(".");
  return files;
}

/** Subsequence fuzzy match; higher is better, null if no match. Returns matched indexes for highlighting. */
function score(file: string, query: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const lower = file.toLowerCase();
  const q = query.toLowerCase();
  const baseStart = lower.lastIndexOf("/") + 1;
  const hits: number[] = [];
  let total = 0;
  let from = 0;
  for (const ch of q) {
    const i = lower.indexOf(ch, from);
    if (i < 0) return null;
    total += 1;
    if (hits.length && hits[hits.length - 1] === i - 1) total += 5; // consecutive
    if (i >= baseStart) total += 3; // in the file name
    if (i === baseStart || "/._-".includes(lower[i - 1] ?? "/")) total += 4; // word start
    hits.push(i);
    from = i + 1;
  }
  return { score: total - file.length * 0.05, hits };
}

/** An action in the command palette, with the key that does the same thing, if any. */
export type PaletteAction = { title: string; keys?: string; run(): void };

type Props = {
  width: number;
  top: number;
  files: string[];
  /** Files opened this session, latest first: listed first when nothing's typed, and ranked higher otherwise. */
  recent?: string[];
  /** Everything Nou can do, shown when the query starts with ">". */
  actions: PaletteAction[];
  /** ">" opens it on the actions (the ? key); empty on files (Ctrl+P). */
  initialQuery?: string;
  onPick(file: string): void;
  onRun(action: PaletteAction): void;
  onClose(): void;
};

/** Ctrl+P: find a file. Start with ">" (or press ?) for every action Nou has, with its shortcut. */
export function QuickOpen({ width, top, files, recent = [], actions, initialQuery = "", onPick, onRun, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const boxWidth = Math.min(80, Math.max(40, width - 10));
  const inner = boxWidth - 2; // fill every cell so the screen underneath doesn't show through
  const commandMode = query.startsWith(">");
  const rowsShown = 12;

  const results = useMemo(() => {
    if (commandMode) return [];
    // Recent files first when nothing's typed; a small boost otherwise, so the one you just had wins a tie.
    const rank = new Map(recent.map((f, i) => [f, i]));
    const boost = (f: string) => (rank.has(f) ? (query ? 3 : 1000) - rank.get(f)! * 0.01 : 0);
    return files
      .map((f) => ({ file: f, m: score(f, query) }))
      .filter((r): r is { file: string; m: { score: number; hits: number[] } } => r.m !== null)
      .sort((a, b) => b.m.score + boost(b.file) - (a.m.score + boost(a.file)))
      .slice(0, rowsShown);
  }, [files, recent, query, commandMode]);

  const found = useMemo(() => {
    if (!commandMode) return [];
    const q = query.slice(1).trim();
    return actions
      .map((a, order) => ({ action: a, m: score(a.title, q), order }))
      .filter((r): r is { action: PaletteAction; m: { score: number; hits: number[] }; order: number } => r.m !== null)
      .sort((a, b) => (q ? b.m.score - a.m.score : a.order - b.order));
  }, [actions, query, commandMode]);
  const count = commandMode ? found.length : results.length;
  const first = Math.max(0, Math.min(cursor - rowsShown + 1, count - rowsShown));

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setCursor((c) => (c - 1 + Math.max(1, count)) % Math.max(1, count));
    else if (key.downArrow) setCursor((c) => (c + 1) % Math.max(1, count));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - rowsShown));
    else if (key.pageDown) setCursor((c) => Math.min(count - 1, c + rowsShown));
  });

  const recentSet = useMemo(() => new Set(recent), [recent]);
  const pad = (s: string) => (s.length > inner ? `…${s.slice(-(inner - 1))}` : s.padEnd(inner));

  return (
    <Box position="absolute" top={top} left={Math.floor((width - boxWidth) / 2)} width={boxWidth} flexDirection="column" borderStyle="round" borderColor={C.accent2}>
      <Text backgroundColor={C.panel}>
        <Text color={C.accent2} bold> ⌕ </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setCursor(0);
          }}
          onSubmit={() => {
            if (commandMode) {
              if (found[cursor]) onRun(found[cursor].action);
            } else if (results[cursor]) onPick(results[cursor].file);
          }}
          placeholder="Go to file…  (> for commands)"
        />
        <Text>{" ".repeat(Math.max(0, inner - 4 - Math.max(query.length, 29)))}</Text>
      </Text>
      <Text color={C.dim}>{"─".repeat(inner)}</Text>
      {commandMode && found.length === 0 && <Text color={C.dim}>{pad("  No matching commands")}</Text>}
      {commandMode && found.slice(first, first + rowsShown).map((r, i) => {
        const selected = first + i === cursor;
        const keys = r.action.keys ?? "";
        const room = inner - 3 - keys.length - 1;
        const title = r.action.title.length > room ? `${r.action.title.slice(0, room - 1)}…` : r.action.title.padEnd(room);
        const hits = new Set(r.m.hits);
        return (
          <Text key={r.action.title} {...(selected ? { backgroundColor: C.panel } : {})}>
            <Text color={selected ? C.accent2 : C.dim}>{selected ? "▌" : " "}</Text>
            <Text color={C.accent2}>› </Text>
            {[...title].map((ch, j) => (
              <Text key={j} color={hits.has(j) ? C.yellow : selected ? C.text : C.dim} bold={hits.has(j)}>{ch}</Text>
            ))}
            <Text color={C.accent}> {keys}</Text>
          </Text>
        );
      })}
      {!commandMode && results.length === 0 && <Text color={C.dim}>{pad("  No matching files")}</Text>}
      {results.map((r, i) => {
        const selected = i === cursor;
        const { icon, color } = fileIcon(r.file);
        const tag = recentSet.has(r.file) ? " recent" : "";
        const label = pad(` ${r.file}`).slice(0, inner - 2 - tag.length);
        const hits = new Set(r.m.hits.map((h) => h + 1));
        return (
          <Text key={r.file} {...(selected ? { backgroundColor: C.panel } : {})}>
            <Text color={selected ? C.accent2 : C.dim}>{selected ? "▌" : " "}</Text>
            <Text color={color}>{icon}</Text>
            {[...label].map((ch, j) => (
              <Text key={j} color={hits.has(j) ? C.yellow : selected ? C.text : C.dim} bold={hits.has(j)}>{ch}</Text>
            ))}
            <Text color={C.dim}>{tag}</Text>
          </Text>
        );
      })}
      <Text color={C.dim}>{pad(commandMode ? ` ↑↓ select · Enter run · Esc close   ${found.length} commands` : " ↑↓ select · Enter open · > commands · Esc close")}</Text>
    </Box>
  );
}
