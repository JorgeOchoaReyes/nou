import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FileChange } from "../commands/index.js";
import { artWork } from "../util/index.js";
import { highlightLines, sideBySide } from "./text.js";
import { Pane } from "./Pane.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  filePath: string | null;
  content: string;
  /** When set, show this change as a side by side diff instead of the file. */
  diff: FileChange | null;
  pending: boolean;
  /** Line numbers to flag in the gutter (recent edits). */
  marked: Set<number>;
};

export function CodeView({ width, height, focused, filePath, content, diff, pending, marked }: Props) {
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
  useInput((input, key) => {
    if (key.upArrow || input === "k") setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp || input === "u") setTop((t) => Math.max(0, t - rows));
    else if (key.pageDown || input === "d" || input === " ") setTop((t) => Math.min(maxTop, t + rows));
    else if (input === "g") setTop(0);
    else if (input === "G") setTop(maxTop);
  }, { isActive: focused });

  const start = Math.min(top, maxTop);
  const scroll = total > rows ? ` ${start + 1}-${Math.min(total, start + rows)}/${total}` : "";

  if (diff) {
    const half = Math.floor((inner - 1) / 2);
    const gutter = String(diffRows.length).length + 1;
    const cell = (c: { n: number; text: string } | undefined, side: "-" | "+", changed: boolean, w: number) => {
      if (!c) return <Box width={w}><Text dimColor wrap="truncate-end">{" ".repeat(gutter)}</Text></Box>;
      const color = changed ? (side === "-" ? "red" : "green") : undefined;
      return (
        <Box width={w}>
          <Text wrap="truncate-end" {...(color ? { color } : { dimColor: true })}>
            {String(c.n).padStart(gutter - 1)}{changed ? side : " "}{c.text || " "}
          </Text>
        </Box>
      );
    };
    const title = pending
      ? ` ${diff.isNew ? "New file" : "Proposed edit"}: ${diff.path}   [y] accept  [n] reject`
      : ` Diff: ${diff.path}${scroll}`;
    return (
      <Pane title={title} width={width} height={height} focused={focused} {...(pending ? { accent: "yellow" } : {})}>
        <Box flexDirection="column">
          {diffRows.slice(start, start + rows).map((row, i) => (
            <Box key={start + i} flexDirection="row">
              {cell(row.left, "-", row.changed, half)}
              <Text color="gray">│</Text>
              {cell(row.right, "+", row.changed, inner - half - 1)}
            </Box>
          ))}
        </Box>
      </Pane>
    );
  }

  if (!filePath) {
    return (
      <Pane title=" Nou" width={width} height={height} focused={focused}>
        <Box flexDirection="column" paddingX={1}>
          {inner > 60 && <Text color="cyan">{artWork}</Text>}
          <Text>Hello, I am Nou! 🌞</Text>
          <Text dimColor>Pick a file on the left, or ask me something on the right.</Text>
          <Text dimColor>Files I read or edit open here as I work.</Text>
        </Box>
      </Pane>
    );
  }

  const gutter = String(lines.length).length;
  return (
    <Pane title={` ${filePath}${scroll}`} width={width} height={height} focused={focused}>
      <Box flexDirection="column">
        {lines.slice(start, start + rows).map((line, i) => {
          const n = start + i + 1;
          return (
            <Text key={n} wrap="truncate-end">
              <Text color={marked.has(n) ? "green" : "gray"}>{String(n).padStart(gutter)}{marked.has(n) ? "▎" : " "}</Text>
              {line || " "}
            </Text>
          );
        })}
      </Box>
    </Pane>
  );
}
