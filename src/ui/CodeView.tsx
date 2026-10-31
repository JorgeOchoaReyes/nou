import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import type { FileChange } from "../commands/index.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { SEVERITY_STYLE } from "./ProblemsView.js";
import { artWork } from "../util/index.js";
import { foldRanges, highlightLines, markAnsi, sideBySide, sliceAnsi, splitLines, unfoldedLines } from "./text.js";
import { C, fileIcon, gradient } from "./theme.js";
import { Pane } from "./Pane.js";
import { Scrollbar, topFor, type ScrollTo, type Wheel } from "./scroll.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  filePath: string | null;
  content: string;
  /** When set, show this change as a side by side diff instead of the file. */
  diff: FileChange | null;
  /** What the diff compares, e.g. "vs HEAD" or "Nou's edit". */
  diffLabel: string;
  pending: boolean;
  /** Line numbers to flag in the gutter (recent edits). */
  marked: Set<number>;
  /** Problems in this file, shown in the gutter and at the end of their line. */
  problems: Diagnostic[];
  /**
   * Scroll so this line is in view (nonce lets the same line be requested twice). With `path`, lines
   * `line` to `to` of that file are highlighted too: what Nou was asked to find.
   */
  focusLine: { line: number; to?: number; path?: string; nonce: number } | null;
  /** Bumped when a syntax grammar finishes loading, to re-highlight. */
  syntaxVersion: number;
  /** A one-line note for the problems count, e.g. "+2 problems" on a proposed edit. */
  diffNote?: string | null;
  wheel?: Wheel | null;
  /** A click or drag on the scrollbar. */
  scrollTo?: ScrollTo | null;
  /** The first and last file lines on screen, and every line shown (folds hide some in between). */
  onViewport(top: number, bottom: number, lines?: number[]): void;
  /** A Ctrl/Alt+click or right-click on the code: `row` from the top of the code, `x` from its left edge. */
  defineAt?: { row: number; x: number; nonce: number } | null;
  /** Go to the definition of what's at `line`:`col` (1-based, in the file's own text). */
  onDefine?(line: number, col: number): void;
  /** The open files as tabs, shown in the title row instead of the file's path. */
  tabs?: ReactNode;
  /** Whether the find bar (Ctrl+F) is open, so the app leaves the keyboard to it. */
  onFinding?(open: boolean): void;
  /** Changes to open the find bar. */
  findRequest?: number;
  /** A click on the fold marker of a row (0 = first row under the title): folds or unfolds it. */
  foldClick?: { row: number; nonce: number } | null;
  /** /fold, /unfold: every region in the file. */
  foldAll?: { fold: boolean; nonce: number } | null;
};

/** The current match: a yellow background; the others are shown inverted. */
const CURRENT_MATCH = ["\x1b[43m\x1b[30m", "\x1b[49m\x1b[39m"] as const;

/** Columns ←/→ and Shift+wheel move sideways. */
const SIDE_STEP = 8;
const EDIT_HINT = "   double-click or e to edit · v diff";

export const CodeView = memo(function CodeView({ width, height, focused, filePath, content, diff, diffLabel, pending, marked, problems, focusLine, syntaxVersion, diffNote, wheel, scrollTo, onViewport, defineAt, onDefine, tabs, onFinding, findRequest, foldClick, foldAll }: Props) {
  const [top, setTop] = useState(0);
  // Columns scrolled sideways (colors are kept: see sliceAnsi).
  const [left, setLeft] = useState(0);
  // Ctrl+F: what's being looked for, and which match is current.
  const [find, setFind] = useState<{ query: string; index: number } | null>(null);
  useEffect(() => onFinding?.(!!find), [!!find]);
  useEffect(() => setFind(null), [filePath]);
  // Only a new request opens it: not the old one seen again when the view comes back (after the editor, settings...).
  const lastFindRequest = useRef(findRequest);
  useEffect(() => {
    if (findRequest && findRequest !== lastFindRequest.current) setFind({ query: "", index: 0 });
    lastFindRequest.current = findRequest;
  }, [findRequest]);
  const rows = Math.max(1, height - 3 - (find ? 1 : 0));
  const inner = width - 3; // minus the borders and the scrollbar

  const lines = useMemo(() => (filePath ? highlightLines(filePath, content) : []), [filePath, content, syntaxVersion]);
  const problemsByLine = useMemo(() => {
    const map = new Map<number, Diagnostic[]>();
    for (const d of problems) map.set(d.line, [...(map.get(d.line) ?? []), d]);
    return map;
  }, [problems]);
  const diffRows = useMemo(() => (diff ? sideBySide(diff.before, diff.after) : []), [diff]);
  // Folding: regions from indentation, the ones folded, and the file lines left showing (rows map to these).
  const ranges = useMemo(() => (filePath && !diff ? foldRanges(content) : new Map<number, number>()), [filePath, content, !!diff]);
  const [folded, setFolded] = useState<Set<number>>(new Set());
  useEffect(() => setFolded(new Set()), [filePath]);
  const shown = useMemo(() => unfoldedLines(lines.length, ranges, folded), [lines.length, ranges, folded]);
  /** The row a file line is on (a folded-away line: its fold's row). */
  const rowOf = (line: number, list = shown) => {
    let row = 0;
    while (row + 1 < list.length && list[row + 1]! <= line) row++;
    return row;
  };
  /** Opens any fold hiding `line`, and returns the rows with it open. */
  const reveal = (line: number) => {
    const hiding = [...folded].filter((s) => s < line && (ranges.get(s) ?? 0) >= line);
    if (!hiding.length) return shown;
    const next = new Set([...folded].filter((s) => !hiding.includes(s)));
    setFolded(next);
    return unfoldedLines(lines.length, ranges, next);
  };
  const total = diff ? diffRows.length : shown.length;

  // Jump to the first change whenever a new file or diff is shown.
  useEffect(() => {
    const first = diff
      ? diffRows.findIndex((r) => r.changed)
      : marked.size ? rowOf(Math.min(...marked)) : 0;
    setTop(Math.max(0, first - 3));
    setLeft(0);
  }, [filePath, diff, diffRows, marked]);

  useEffect(() => {
    if (focusLine && !diff) setTop(Math.max(0, rowOf(focusLine.line, reveal(focusLine.line)) + 1 - Math.floor(rows / 3)));
  }, [focusLine]);

  const maxTop = Math.max(0, total - rows);
  const start = Math.min(top, maxTop);
  const shownLines = useMemo(() => (find ? splitLines(content) : []), [content, !!find]);
  const matches = useMemo(() => {
    const out: { line: number; col: number }[] = [];
    const q = find?.query.toLowerCase();
    if (!q) return out;
    shownLines.forEach((text, i) => {
      const lower = text.toLowerCase();
      for (let at = lower.indexOf(q); at >= 0 && out.length < 10_000; at = lower.indexOf(q, at + q.length)) out.push({ line: i, col: at });
    });
    return out;
  }, [shownLines, find?.query]);
  const current = find && matches.length ? matches[((find.index % matches.length) + matches.length) % matches.length]! : null;
  // Bring the current match into view (a third of the way down, like a jump), sideways too.
  useEffect(() => {
    if (!current) return;
    const list = reveal(current.line + 1);
    const at = rowOf(current.line + 1, list);
    if (at < start || at >= start + rows) setTop(Math.max(0, at - Math.floor(rows / 3)));
    const room = inner - String(lines.length).length - 2;
    if (current.col < left || current.col + (find?.query.length ?? 0) > left + room) setLeft(Math.max(0, current.col - Math.floor(room / 3)));
  }, [current?.line, current?.col]);
  const found = focusLine?.path && focusLine.path === filePath ? { from: focusLine.line, to: Math.max(focusLine.line, focusLine.to ?? focusLine.line) } : null;

  useEffect(() => {
    if (!wheel) return;
    if (wheel.lines) setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + wheel.lines)));
    if (wheel.columns) setLeft((l) => Math.max(0, l + wheel.columns * 2));
  }, [wheel?.nonce]);
  useEffect(() => {
    if (scrollTo) setTop(topFor(scrollTo.fraction, total, rows));
  }, [scrollTo?.nonce]);

  useEffect(() => {
    if (filePath && !diff) {
      const onScreen = shown.slice(start, start + rows);
      onViewport(onScreen[0] ?? 1, onScreen[onScreen.length - 1] ?? 1, onScreen);
    }
  }, [filePath, diff, start, rows, total, shown]);
  useEffect(() => {
    if (!foldClick || diff) return;
    const n = shown[start + foldClick.row];
    if (n === undefined || !ranges.has(n)) return;
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, [foldClick?.nonce]);
  useEffect(() => {
    if (foldAll && !diff) setFolded(foldAll.fold ? new Set(ranges.keys()) : new Set());
  }, [foldAll?.nonce]);

  useEffect(() => {
    if (!defineAt || diff || !filePath) return;
    const n = shown[start + defineAt.row];
    if (n === undefined) return;
    const raw = content.replace(/\r\n/g, "\n").split("\n")[n - 1];
    if (raw === undefined) return;
    // Screen column to the file's own column: tabs are shown as two spaces.
    const want = defineAt.x - (String(lines.length).length + 2) + left;
    let cells = 0;
    let col = 0;
    while (col < raw.length && cells + (raw[col] === "\t" ? 2 : 1) <= want) cells += raw[col++] === "\t" ? 2 : 1;
    onDefine?.(n, col + 1);
  }, [defineAt?.nonce]);

  useInput((input, key) => {
    if (!find) return;
    if (key.escape) return setFind(null);
    if (key.return || key.downArrow || (key.ctrl && input === "g")) return setFind((f) => f && { ...f, index: f.index + 1 });
    if (key.upArrow) return setFind((f) => f && { ...f, index: f.index - 1 });
    if (key.backspace || key.delete) return setFind((f) => f && { query: f.query.slice(0, -1), index: 0 });
    if (key.ctrl && input === "f") return;
    if (input && !key.ctrl && !key.meta && input >= " ") setFind((f) => f && { query: f.query + input, index: 0 });
  }, { isActive: focused && !!find });

  useInput((input, key) => {
    if (find) return;
    if (key.ctrl && input === "f" && !diff) return setFind({ query: "", index: 0 });
    if (key.upArrow || input === "k") setTop((t) => Math.max(0, Math.min(t, maxTop) - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, Math.min(t, maxTop) - rows));
    else if (key.pageDown || input === "d" || input === " ") setTop((t) => Math.min(maxTop, t + rows));
    else if (input === "g" || key.home) setTop(0);
    else if (input === "G" || key.end) setTop(maxTop);
    // z: fold everything, or (when it already is) open everything.
    else if (input === "z" && !diff && ranges.size) setFolded([...ranges.keys()].every((k) => folded.has(k)) ? new Set() : new Set(ranges.keys()));
    else if (key.leftArrow || input === "h") setLeft((l) => Math.max(0, l - SIDE_STEP));
    else if (key.rightArrow || input === "l") setLeft((l) => l + SIDE_STEP);
    else if (diff && !pending && (input === "n" || input === "N")) {
      // Jump between change hunks.
      const starts = diffRows.flatMap((r, i) => (r.changed && !diffRows[i - 1]?.changed ? [i] : []));
      const target = input === "n" ? starts.find((s) => s - 3 > start) : [...starts].reverse().find((s) => s - 3 < start);
      if (target !== undefined) setTop(Math.max(0, Math.min(maxTop, target - 3)));
    }
  }, { isActive: focused });

  const scroll = (total > rows ? `  ${start + 1}-${Math.min(total, start + rows)}/${total}` : "") + (left ? `  →${left}` : "");
  const percent = total > rows ? Math.round(((start + rows) / total) * 100) : 100;

  if (diff) {
    const half = Math.floor((inner - 1) / 2);
    const gutter = String(diffRows.length).length + 1;
    const added = diffRows.filter((r) => r.changed && r.right).length;
    const removed = diffRows.filter((r) => r.changed && r.left).length;
    const cell = (c: { n: number; text: string } | undefined, side: "-" | "+", changed: boolean, w: number) => {
      if (!c) return <Box width={w}><Text color={C.dim} wrap="truncate-end">{"╱".repeat(Math.max(0, w))}</Text></Box>;
      const color = changed ? (side === "-" ? C.red : C.green) : undefined;
      return (
        <Box width={w}>
          <Text wrap="truncate-end" {...(color ? { color } : { color: C.dim })}>
            {String(c.n).padStart(gutter - 1)}{changed ? side : " "}{c.text.slice(left) || " "}
          </Text>
        </Box>
      );
    };
    const { icon, color } = fileIcon(diff.path);
    const title = (
      <>
        {" "}<Text color={color}>{icon}</Text> {diff.path}{"  "}
        <Text backgroundColor={pending ? C.yellow : C.accent2} color="black">{pending ? (diff.isNew ? " NEW FILE " : " PROPOSED ") : ` ${diffLabel.toUpperCase()} `}</Text>
        {"  "}<Text color={C.green}>+{added}</Text> <Text color={C.red}>-{removed}</Text>
        {diffNote ? <Text color={diffNote.startsWith("✓") ? C.green : C.red}>{"  "}{diffNote}</Text> : null}
        <Text color={C.dim}>{pending ? "   y accept · n reject" : "   n/N next/prev change"}{scroll}</Text>
      </>
    );
    return (
      <Pane title={title} width={width} height={height} focused={focused} {...(pending ? { accent: C.yellow } : {})}>
        <Box flexDirection="row" height={rows}>
          <Box flexDirection="column" width={inner} flexShrink={0}>
            {diffRows.slice(start, start + rows).map((row, i) => (
              <Box key={start + i} flexDirection="row">
                {cell(row.left, "-", row.changed, half)}
                <Text color={C.dim}>│</Text>
                {cell(row.right, "+", row.changed, inner - half - 1)}
              </Box>
            ))}
          </Box>
          <Scrollbar total={total} top={start} rows={rows} focused={focused} />
        </Box>
      </Pane>
    );
  }

  if (!filePath) {
    const tips: [string, string][] = [
      ["?", "everything Nou can do, searchable"],
      ["Ctrl+P", "find a file (recent ones first)"],
      ["/", "commands, with a menu"],
      ["Tab", "switch panes (or click one)"],
      ["e", "edit the open file (or double-click it)"],
      ["v", "diff vs git HEAD"],
      ["drag", "a pane's border to resize it"],
      ["s", "settings: models, keys, plugins"],
    ];
    return (
      <Pane title={<> <Text color={C.accent2}>✦</Text> Welcome</>} width={width} height={height} focused={focused}>
        <Box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
          {inner > 62 && artWork.split("\n").filter((l) => l.trim()).map((line, i) => (
            <Text key={i}>{gradient(line, i).map((g, j) => <Text key={j} color={g.color}>{g.ch}</Text>)}</Text>
          ))}
          <Text> </Text>
          <Text bold color={C.text}>Hello, I am Nou! 🌞  Your terminal coding companion.</Text>
          <Text color={C.dim}>Ask in the chat on the right. Files I read or edit open here as I work.</Text>
          <Text> </Text>
          {tips.map(([k, d]) => (
            <Text key={k}>  <Text color={C.accent} bold>{k.padEnd(10)}</Text><Text color={C.dim}>{d}</Text></Text>
          ))}
        </Box>
      </Pane>
    );
  }

  const gutter = String(lines.length).length;
  const { icon, color } = fileIcon(filePath);
  const errorCount = problems.filter((d) => d.severity === "error").length;
  const warningCount = problems.filter((d) => d.severity === "warning").length;
  // The edit hint only when it fits: a cut-off hint reads as noise.
  const titleRoom = tabs ? 0 : width - 4 - (3 + filePath.length + (errorCount ? 5 + String(errorCount).length : 0) + (warningCount ? 5 + String(warningCount).length : 0) + scroll.length + (total > rows ? 7 : 0));
  const title = (
    <>
      {tabs ?? <>{" "}<Text color={color}>{icon}</Text> {filePath}</>}
      {errorCount > 0 && <Text color={C.red}>  ✖ {errorCount}</Text>}
      {warningCount > 0 && <Text color={C.yellow}>  ▲ {warningCount}</Text>}
      {/* After the tabs, as room allows (the row is cut, not wrapped, when they fill it). */}
      <Text color={C.dim}>{scroll}{total > rows ? ` (${percent}%)` : ""}{focused && titleRoom >= EDIT_HINT.length ? EDIT_HINT : ""}</Text>
    </>
  );
  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={inner} flexShrink={0}>
          {shown.slice(start, start + rows).map((n) => {
            const line = lines[n - 1] ?? "";
            const fold = ranges.get(n);
            const isFolded = fold !== undefined && folded.has(n);
            const isFound = !!found && n >= found.from && n <= found.to;
            const isMarked = marked.has(n);
            const here = problemsByLine.get(n);
            const worst = here?.[0];
            const style = worst ? SEVERITY_STYLE[worst.severity] : null;
            return (
              <Text key={n} wrap="truncate-end">
                <Text color={style?.color ?? (isMarked ? C.green : C.dim)}>{String(n).padStart(gutter)}</Text>
                {style ? <Text color={style.color}>{style.icon}</Text> : isFound ? <Text color={C.cyan} bold>▌</Text> : <Text color={isMarked ? C.green : C.dim}>{isMarked ? "▎" : " "}</Text>}
                <Text color={isFolded ? C.accent2 : C.dim}>{fold === undefined ? " " : isFolded ? "▸" : "▾"}</Text>
                {(() => {
                  let text = line;
                  if (find?.query) {
                    for (const m of matches) {
                      if (m.line !== n - 1) continue;
                      const now = m === current;
                      text = markAnsi(text, m.col, m.col + find.query.length, ...(now ? CURRENT_MATCH : []));
                    }
                  }
                  text = (left ? sliceAnsi(text, left) : text) || " ";
                  return isFound ? <Text backgroundColor={C.panel}>{text}</Text> : text;
                })()}
                {isFolded ? <Text color={C.accent2} backgroundColor={C.panel}>{` ⋯ ${fold - n} lines `}</Text> : null}
                {worst && style ? <Text color={style.color} dimColor>{"   "}{style.icon} {worst.message}{here!.length > 1 ? ` (+${here!.length - 1})` : ""}</Text> : null}
              </Text>
            );
          })}
        </Box>
        <Scrollbar total={total} top={start} rows={rows} focused={focused} />
      </Box>
      {find ? (
        <Text wrap="truncate-end">
          <Text color={C.accent2} bold> ⌕ </Text>
          <Text backgroundColor={C.panel}>{find.query}</Text><Text inverse> </Text>
          <Text color={find.query && !matches.length ? C.red : C.dim}>
            {"  "}{find.query ? (matches.length ? `${matches.indexOf(current!) + 1}/${matches.length}${matches.length >= 10_000 ? "+" : ""}` : "no matches") : "type to find"}
            {"  "}Enter/↓ next · ↑ previous · Esc close
          </Text>
        </Text>
      ) : null}
    </Pane>
  );
});
