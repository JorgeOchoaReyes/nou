import { memo, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FileChange } from "../commands/index.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { SEVERITY_STYLE } from "./ProblemsView.js";
import { artWork } from "../util/index.js";
import { highlightLines, sideBySide, splitLines } from "./text.js";
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
  /** Scroll so this line is in view (nonce lets the same line be requested twice). */
  focusLine: { line: number; nonce: number } | null;
  /** Bumped when a syntax grammar finishes loading, to re-highlight. */
  syntaxVersion: number;
  /** A one-line note for the problems count, e.g. "+2 problems" on a proposed edit. */
  diffNote?: string | null;
  wheel?: Wheel | null;
  /** A click or drag on the scrollbar. */
  scrollTo?: ScrollTo | null;
  onViewport(top: number, bottom: number): void;
};

/** Columns ←/→ and Shift+wheel move sideways. */
const SIDE_STEP = 8;

export const CodeView = memo(function CodeView({ width, height, focused, filePath, content, diff, diffLabel, pending, marked, problems, focusLine, syntaxVersion, diffNote, wheel, scrollTo, onViewport }: Props) {
  const [top, setTop] = useState(0);
  // Columns scrolled sideways. Scrolled lines show without colors (slicing colored text could cut a color code in half).
  const [left, setLeft] = useState(0);
  const rows = Math.max(1, height - 3);
  const inner = width - 3; // minus the borders and the scrollbar

  const lines = useMemo(() => (filePath ? highlightLines(filePath, content) : []), [filePath, content, syntaxVersion]);
  const plain = useMemo(() => (left > 0 ? splitLines(content) : []), [content, left > 0]);
  const problemsByLine = useMemo(() => {
    const map = new Map<number, Diagnostic[]>();
    for (const d of problems) map.set(d.line, [...(map.get(d.line) ?? []), d]);
    return map;
  }, [problems]);
  const diffRows = useMemo(() => (diff ? sideBySide(diff.before, diff.after) : []), [diff]);
  const total = diff ? diffRows.length : lines.length;

  // Jump to the first change whenever a new file or diff is shown.
  useEffect(() => {
    const first = diff
      ? diffRows.findIndex((r) => r.changed)
      : marked.size ? Math.min(...marked) - 1 : 0;
    setTop(Math.max(0, first - 3));
    setLeft(0);
  }, [filePath, diff, diffRows, marked]);

  useEffect(() => {
    if (focusLine && !diff) setTop(Math.max(0, focusLine.line - Math.floor(rows / 3)));
  }, [focusLine]);

  const maxTop = Math.max(0, total - rows);
  const start = Math.min(top, maxTop);

  useEffect(() => {
    if (!wheel) return;
    if (wheel.lines) setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + wheel.lines)));
    if (wheel.columns) setLeft((l) => Math.max(0, l + wheel.columns * 2));
  }, [wheel?.nonce]);
  useEffect(() => {
    if (scrollTo) setTop(topFor(scrollTo.fraction, total, rows));
  }, [scrollTo?.nonce]);

  useEffect(() => {
    if (filePath && !diff) onViewport(start + 1, Math.min(total, start + rows));
  }, [filePath, diff, start, rows, total]);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setTop((t) => Math.max(0, Math.min(t, maxTop) - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, Math.min(t, maxTop) - rows));
    else if (key.pageDown || input === "d" || input === " ") setTop((t) => Math.min(maxTop, t + rows));
    else if (input === "g" || key.home) setTop(0);
    else if (input === "G" || key.end) setTop(maxTop);
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
      ["Ctrl+P", "find a file"],
      ["Tab", "switch panes"],
      ["e", "edit the open file"],
      ["v", "diff vs git HEAD"],
      ["/settings", "models, preferences, plugins"],
    ];
    return (
      <Pane title={<> <Text color={C.accent2}>✦</Text> Welcome</>} width={width} height={height} focused={focused}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
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
  const title = (
    <>
      {" "}<Text color={color}>{icon}</Text> {filePath}
      {errorCount > 0 && <Text color={C.red}>  ✖ {errorCount}</Text>}
      {warningCount > 0 && <Text color={C.yellow}>  ▲ {warningCount}</Text>}
      <Text color={C.dim}>{scroll}{total > rows ? ` (${percent}%)` : ""}{focused ? "   click or e to edit · v diff" : ""}</Text>
    </>
  );
  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={inner} flexShrink={0}>
          {lines.slice(start, start + rows).map((line, i) => {
            const n = start + i + 1;
            const isMarked = marked.has(n);
            const here = problemsByLine.get(n);
            const worst = here?.[0];
            const style = worst ? SEVERITY_STYLE[worst.severity] : null;
            return (
              <Text key={n} wrap="truncate-end">
                <Text color={style?.color ?? (isMarked ? C.green : C.dim)}>{String(n).padStart(gutter)}</Text>
                {style ? <Text color={style.color}>{style.icon}</Text> : <Text color={isMarked ? C.green : C.dim}>{isMarked ? "▎" : " "}</Text>}
                {(left ? plain[start + i]?.slice(left) : line) || " "}
                {worst && style ? <Text color={style.color} dimColor>{"   "}{style.icon} {worst.message}{here!.length > 1 ? ` (+${here!.length - 1})` : ""}</Text> : null}
              </Text>
            );
          })}
        </Box>
        <Scrollbar total={total} top={start} rows={rows} focused={focused} />
      </Box>
    </Pane>
  );
});
