import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { codeSearch, type CodeSearchMatch } from "../search/index.js";
import { C, fileIcon } from "./theme.js";

type Props = {
  width: number;
  top: number;
  /** What the search starts with: /search <text> opens it already typed. */
  initialQuery?: string;
  onPick(match: CodeSearchMatch): void;
  onClose(): void;
};

/** Ctrl+F from the chat or the files: search the whole codebase as you type. Enter opens a match, Esc closes. */
export function CodeSearch({ width, top, initialQuery = "", onPick, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const [found, setFound] = useState<{ matches: CodeSearchMatch[]; total: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const boxWidth = Math.min(80, Math.max(40, width - 10));
  const inner = boxWidth - 2; // fill every cell so the screen underneath doesn't show through
  const rowsShown = 12;
  const runs = useRef(0);

  // Searches a beat after the last keystroke, so typing "const" doesn't run five searches; a late answer
  // to an older query is dropped, so results always belong to what's typed now.
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setFound(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++runs.current;
    const timer = setTimeout(() => {
      void codeSearch({ pattern: text }).then((r) => {
        if (runs.current !== mine) return;
        setFound(r);
        setSearching(false);
        setCursor(0);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const matches = found?.matches ?? [];
  const count = matches.length;
  const total = found?.total ?? 0;
  const first = Math.max(0, Math.min(cursor - rowsShown + 1, count - rowsShown));

  useInput((_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setCursor((c) => (c - 1 + Math.max(1, count)) % Math.max(1, count));
    else if (key.downArrow) setCursor((c) => (c + 1) % Math.max(1, count));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - rowsShown));
    else if (key.pageDown) setCursor((c) => Math.min(Math.max(0, count - 1), c + rowsShown));
  });

  const pad = (s: string) => (s.length > inner ? `…${s.slice(-(inner - 1))}` : s.padEnd(inner));
  const q = query.trim();

  return (
    <Box position="absolute" top={top} left={Math.floor((width - boxWidth) / 2)} width={boxWidth} flexDirection="column" borderStyle="round" borderColor={C.accent2}>
      <Text backgroundColor={C.panel}>
        <Text color={C.accent2} bold> ⌕ </Text>
        <TextInput
          value={query}
          onChange={setQuery}
          onSubmit={() => matches[cursor] && onPick(matches[cursor]!)}
          placeholder="Search the codebase…"
        />
        <Text>{" ".repeat(Math.max(0, inner - 4 - Math.max(query.length, 21)))}</Text>
      </Text>
      <Text color={C.dim}>{"─".repeat(inner)}</Text>
      {q && !searching && count === 0 && <Text color={C.dim}>{pad(`  No matches for "${q}"`)}</Text>}
      {matches.slice(first, first + rowsShown).map((m, i) => {
        const selected = first + i === cursor;
        const where = `${m.file}:${m.line}`;
        const { icon, color } = fileIcon(m.file);
        const room = Math.max(1, inner - 3 - where.length - 2); // marker, icon and two spaces before the text
        const text = m.text.length > room ? `${m.text.slice(0, room - 1)}…` : m.text;
        // The match picked out in yellow, like QuickOpen's hits; smart case, as the search ran.
        const at = q === q.toLowerCase() ? text.toLowerCase().indexOf(q.toLowerCase()) : text.indexOf(q);
        const hits = new Set<number>();
        if (at >= 0) for (let j = at; j < at + q.length; j++) hits.add(j);
        return (
          <Text key={`${m.file}:${m.line}:${first + i}`} {...(selected ? { backgroundColor: C.panel } : {})}>
            <Text color={selected ? C.accent2 : C.dim}>{selected ? "▌" : " "}</Text>
            <Text color={color}>{icon}</Text>
            <Text color={C.accent2}>{` ${where} `}</Text>
            {[...text].map((ch, j) => (
              <Text key={j} color={hits.has(j) ? C.yellow : selected ? C.text : C.dim} bold={hits.has(j)}>{ch}</Text>
            ))}
            <Text>{" ".repeat(Math.max(0, room - text.length))}</Text>
          </Text>
        );
      })}
      <Text color={C.dim}>{pad(searching ? " ↑↓ select · Enter open · Esc close   searching…" : ` ↑↓ select · Enter open · Esc close   ${total} match${total === 1 ? "" : "es"}${total > count ? ` · first ${count} shown` : ""}`)}</Text>
    </Box>
  );
}
