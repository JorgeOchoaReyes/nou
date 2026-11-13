import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Pane } from "./Pane.js";
import { C } from "./theme.js";
import { usePaneWheel } from "./scroll.js";
import { drawFlowchart, parseFlowchart, type Cell, type Diagram, type Kind } from "../diagram/index.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  diagram: Diagram;
  tabs?: ReactNode;
  wheelPane?: string;
  /** A click in the diagram, in columns and rows from the top left of what's drawn on screen. */
  click: { x: number; y: number; nonce: number } | null;
  onOpenRef(ref: { path: string; line?: number }): void;
  onOpenBrowser(): void;
};

const BORDER: Record<Kind, string> = { new: "green", changed: "yellow", removed: "red", plain: "accent" };

/**
 * A diagram the agent drew, in the code view: boxes and arrows in text that scroll like code. A box naming a
 * file opens it when clicked; o opens the same diagram, fully drawn, in the browser.
 */
export const DiagramView = memo(function DiagramView({ width, height, focused, diagram, tabs, wheelPane, click, onOpenRef, onOpenBrowser }: Props) {
  const chart = useMemo(() => parseFlowchart(diagram.source), [diagram.source]);
  const drawn = useMemo(() => (chart ? drawFlowchart(chart) : null), [chart]);
  const inner = width - 2;
  const rows = Math.max(1, height - 4); // border, title, footer
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const maxTop = Math.max(0, (drawn?.height ?? 0) - rows);
  const maxLeft = Math.max(0, (drawn?.width ?? 0) - inner + 1);
  const wheel = usePaneWheel(wheelPane);
  useEffect(() => {
    if (!wheel) return;
    if (wheel.lines) setTop((t) => Math.max(0, Math.min(maxTop, t + wheel.lines)));
    if (wheel.columns) setLeft((l) => Math.max(0, Math.min(maxLeft, l + wheel.columns * 2)));
  }, [wheel?.nonce]);
  useEffect(() => {
    setTop(0);
    setLeft(0);
  }, [diagram.source]);
  useInput((input, key) => {
    if (key.upArrow) setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    else if (key.leftArrow) setLeft((l) => Math.max(0, l - 4));
    else if (key.rightArrow) setLeft((l) => Math.min(maxLeft, l + 4));
    else if (key.pageUp) setTop((t) => Math.max(0, t - rows));
    else if (key.pageDown) setTop((t) => Math.min(maxTop, t + rows));
    else if (key.home) setTop(0);
    else if (key.end) setTop(maxTop);
    else if (input === "o" && !key.ctrl && !key.meta) onOpenBrowser();
  }, { isActive: focused });
  // A click on a box that names a file opens it there.
  useEffect(() => {
    if (!click || !drawn || !chart) return;
    const id = drawn.cells[top + click.y]?.[left + click.x]?.node;
    const ref = id ? chart.nodes.get(id)?.ref : null;
    if (ref) onOpenRef(ref);
  }, [click?.nonce]);

  const kindOf = useMemo(() => new Map(drawn?.boxes.map((b) => [b.id, b.kind]) ?? []), [drawn]);
  const colorOf = (cell: Cell): { color: string; bold?: boolean; italic?: boolean } => {
    if (cell.style === "edge") return { color: C.dim };
    if (cell.style === "edgeLabel") return { color: C.dim, italic: true };
    const kind = cell.node ? kindOf.get(cell.node) ?? "plain" : "plain";
    if (cell.style === "border") return { color: (C as Record<string, string>)[BORDER[kind]]! };
    if (cell.style === "title") return { color: kind === "plain" ? C.text : (C as Record<string, string>)[BORDER[kind]]!, bold: true };
    return { color: C.text };
  };

  const title = tabs ?? <>{" "}<Text color={C.accent2}>◈</Text> Diagram: {diagram.title}</>;
  if (!drawn) {
    // Not a flowchart (a sequence diagram, say): the browser draws every kind.
    const source = diagram.source.split("\n").slice(0, rows - 3);
    return (
      <Pane title={title} width={width} height={height} focused={focused}>
        <Text color={C.dim}> This kind of diagram is drawn in the browser: press o.</Text>
        <Text> </Text>
        {source.map((line, i) => <Text key={i} color={C.dim} wrap="truncate-end"> {line}</Text>)}
        <Box flexGrow={1} />
      </Pane>
    );
  }
  const visible = drawn.cells.slice(top, top + rows);
  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      {visible.map((row, i) => {
        const cells = row.slice(left, left + inner);
        // Runs of cells that look the same, drawn as one piece of text.
        const runs: { text: string; look: ReturnType<typeof colorOf> }[] = [];
        for (const cell of cells) {
          const look = cell.style ? colorOf(cell) : { color: C.text };
          const last = runs.at(-1);
          if (last && last.look.color === look.color && last.look.bold === look.bold && last.look.italic === look.italic) last.text += cell.ch;
          else runs.push({ text: cell.ch, look });
        }
        return (
          <Text key={top + i} wrap="truncate-end">
            {runs.map((r, j) => <Text key={j} color={r.look.color} bold={!!r.look.bold} italic={!!r.look.italic}>{r.text}</Text>)}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      <Text wrap="truncate-end">
        <Text color={C.green}> ■</Text><Text color={C.dim}> new </Text>
        <Text color={C.yellow}>■</Text><Text color={C.dim}> changed · ↑↓←→ scroll · click a box: open its file · </Text>
        <Text color={C.text}>o</Text><Text color={C.dim}> browser{maxTop ? `  ${top + 1}-${Math.min(drawn.height, top + rows)}/${drawn.height}` : ""}</Text>
      </Text>
    </Pane>
  );
});
