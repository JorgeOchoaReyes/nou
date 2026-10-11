import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FileChange } from "../commands/index.js";
import { artWork } from "../util/index.js";
import { highlightLines, sideBySide } from "./text.js";
import { C, fileIcon, gradient } from "./theme.js";
import { Pane } from "./Pane.js";

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
  onViewport(top: number, bottom: number): void;
};

export function CodeView({ width, height, focused, filePath, content, diff, diffLabel, pending, marked, onViewport }: Props) {
  const [top, setTop] = useState(0);
  const rows = Math.max(1, height - 3);
  const inner = width - 2;

  const lines = useMemo(() => (filePath ? highlightLines(filePath, content) : []), [filePath, content]);
  const diffRows = useMemo(() => (diff ? sideBySide(diff.before, diff.after) : []), [diff]);
  const total = diff ? diffRows.length : lines.length;

  // Jump to the first change whenever a new file or diff is shown.
  useEffect(() => {
    const first = diff
      ? diffRows.findIndex((r) => r.changed)
      : marked.size ? Math.min(...marked) - 1 : 0;
    setTop(Math.max(0, first - 3));
  }, [filePath, diff, diffRows, marked]);

  const maxTop = Math.max(0, total - rows);
  const start = Math.min(top, maxTop);

  useEffect(() => {
    if (filePath && !diff) onViewport(start + 1, Math.min(total, start + rows));
  }, [filePath, diff, start, rows, total]);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setTop((t) => Math.max(0, Math.min(t, maxTop) - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp || input === "u") setTop((t) => Math.max(0, Math.min(t, maxTop) - rows));
    else if (key.pageDown || input === "d" || input === " ") setTop((t) => Math.min(maxTop, t + rows));
    else if (input === "g") setTop(0);
    else if (input === "G") setTop(maxTop);
    else if (diff && (input === "n" || input === "N")) {
      // Jump between change hunks.
      const starts = diffRows.flatMap((r, i) => (r.changed && !diffRows[i - 1]?.changed ? [i] : []));
      const target = input === "n" ? starts.find((s) => s - 3 > start) : [...starts].reverse().find((s) => s - 3 < start);
      if (target !== undefined) setTop(Math.max(0, Math.min(maxTop, target - 3)));
    }
  }, { isActive: focused });

  const scroll = total > rows ? `  ${start + 1}-${Math.min(total, start + rows)}/${total}` : "";
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
            {String(c.n).padStart(gutter - 1)}{changed ? side : " "}{c.text || " "}
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
        <Text color={C.dim}>{pending ? "   y accept · n reject" : "   n/N next/prev change"}{scroll}</Text>
      </>
    );
    return (
      <Pane title={title} width={width} height={height} focused={focused} {...(pending ? { accent: C.yellow } : {})}>
        <Box flexDirection="column">
          {diffRows.slice(start, start + rows).map((row, i) => (
            <Box key={start + i} flexDirection="row">
              {cell(row.left, "-", row.changed, half)}
              <Text color={C.dim}>│</Text>
              {cell(row.right, "+", row.changed, inner - half - 1)}
            </Box>
          ))}
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
  const title = (
    <>
      {" "}<Text color={color}>{icon}</Text> {filePath}
      <Text color={C.dim}>{scroll}{total > rows ? ` (${percent}%)` : ""}{focused ? "   e edit · v diff" : ""}</Text>
    </>
  );
  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="column">
        {lines.slice(start, start + rows).map((line, i) => {
          const n = start + i + 1;
          const isMarked = marked.has(n);
          return (
            <Text key={n} wrap="truncate-end">
              <Text color={isMarked ? C.green : C.dim}>{String(n).padStart(gutter)}</Text>
              <Text color={isMarked ? C.green : C.dim}>{isMarked ? "▎" : " "}</Text>
              {line || " "}
            </Text>
          );
        })}
      </Box>
    </Pane>
  );
}
