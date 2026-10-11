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

type Props = {
  width: number;
  top: number;
  files: string[];
  onPick(file: string): void;
  onClose(): void;
};

export function QuickOpen({ width, top, files, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxWidth = Math.min(80, Math.max(40, width - 10));
  const inner = boxWidth - 2; // fill every cell so the screen underneath doesn't show through

  const results = useMemo(() => {
    return files
      .map((f) => ({ file: f, m: score(f, query) }))
      .filter((r): r is { file: string; m: { score: number; hits: number[] } } => r.m !== null)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, 12);
  }, [files, query]);

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(results.length - 1, c + 1));
  });

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
          onSubmit={() => results[cursor] && onPick(results[cursor].file)}
          placeholder="Go to file…"
        />
        <Text>{" ".repeat(Math.max(0, inner - 4 - Math.max(query.length, 11)))}</Text>
      </Text>
      <Text color={C.dim}>{"─".repeat(inner)}</Text>
      {results.length === 0 && <Text color={C.dim}>{pad("  No matching files")}</Text>}
      {results.map((r, i) => {
        const selected = i === cursor;
        const { icon, color } = fileIcon(r.file);
        const label = pad(` ${r.file}`).slice(0, inner - 2);
        const hits = new Set(r.m.hits.map((h) => h + 1));
        return (
          <Text key={r.file} {...(selected ? { backgroundColor: C.panel } : {})}>
            <Text color={selected ? C.accent2 : C.dim}>{selected ? "▌" : " "}</Text>
            <Text color={color}>{icon}</Text>
            {[...label].map((ch, j) => (
              <Text key={j} color={hits.has(j) ? C.yellow : selected ? C.text : C.dim} bold={hits.has(j)}>{ch}</Text>
            ))}
          </Text>
        );
      })}
      <Text color={C.dim}>{pad(" ↑↓ select · Enter open · Esc close")}</Text>
    </Box>
  );
}
