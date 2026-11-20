import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Pane } from "./Pane.js";
import { C } from "./theme.js";
import { usePaneWheel } from "./scroll.js";
import { drawFlowchart, parseFlowchart, type Cell, type Diagram, type Kind } from "../diagram/index.js";

/** A mouse drag over the view: where it started and is now (cells of what's on screen), and whether it's let go. */
export type FlowDrag = { from: { x: number; y: number }; to: { x: number; y: number } | null; done: boolean; alt: boolean };

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
  /** A click on a box, or Enter on the selected one: true when it was handled (the sessions view's chats). */
  onNode?(id: string, how: "click" | "enter"): boolean;
  /** Boxes can be selected (the sessions view): the one selected, drawn heavier, and moving it with the arrows. */
  selected?: string | null;
  onSelect?(id: string): void;
  /** What the keys do, on a line under the legend. */
  hint?: string;
  /** Dragging from one box onto another connects them (the sessions view): the drag, and what to do at the end. */
  drag?: FlowDrag | null;
  onConnect?(from: string, to: string, alt: boolean): void;
  onDragEnd?(): void;
  onOpenBrowser(): void;
};

/** The selected box's border, in heavy lines. */
const HEAVY: Record<string, string> = { "┌": "┏", "┐": "┓", "└": "┗", "┘": "┛", "─": "━", "│": "┃" };
const BORDER: Record<Kind, string> = { new: "green", changed: "yellow", removed: "red", plain: "accent" };

/**
 * A diagram the agent drew, in the code view: boxes and arrows in text that scroll like code. A box naming a
 * file opens it when clicked; o opens the same diagram, fully drawn, in the browser.
 */
export const DiagramView = memo(function DiagramView({ width, height, focused, diagram, tabs, wheelPane, click, onOpenRef, onNode, selected, onSelect, hint, drag, onConnect, onDragEnd, onOpenBrowser }: Props) {
  const kindsKey = JSON.stringify(diagram.kinds ?? {});
  const chart = useMemo(() => {
    const parsed = parseFlowchart(diagram.source);
    for (const [id, kind] of Object.entries(diagram.kinds ?? {})) {
      const node = parsed?.nodes.get(id);
      if (node) node.kind = kind;
    }
    return parsed;
  }, [diagram.source, kindsKey]);
  const drawn = useMemo(() => (chart ? drawFlowchart(chart) : null), [chart]);
  const inner = width - 2;
  const rows = Math.max(1, height - 4 - (hint ? 1 : 0)); // border, title, footer (and the hint)
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
  }, [diagram.title]);
  // Selecting boxes: the arrows go to the nearest box that way, and the view scrolls to keep it in sight.
  const boxOf = (id: string | null | undefined) => (id ? drawn?.boxes.find((b) => b.id === id) : undefined);
  const moveSelection = (dx: number, dy: number) => {
    const from = boxOf(selected) ?? drawn?.boxes[0];
    if (!from || !drawn) return;
    const cx = (b: typeof from) => b.x + b.w / 2;
    const cy = (b: typeof from) => b.y + b.h / 2;
    const ahead = drawn.boxes.filter((b) => b !== from && (dx ? Math.sign(cx(b) - cx(from)) === dx : Math.sign(cy(b) - cy(from)) === dy));
    // Along the way you pressed counts once; across it, three times, so ↓ goes down rather than sideways.
    const cost = (b: typeof from) => (dx ? Math.abs(cx(b) - cx(from)) + 3 * Math.abs(cy(b) - cy(from)) : Math.abs(cy(b) - cy(from)) + 3 * Math.abs(cx(b) - cx(from)));
    const next = ahead.sort((a, b) => cost(a) - cost(b))[0];
    if (next) onSelect!(next.id);
  };
  useEffect(() => {
    const b = boxOf(selected);
    if (!b) return;
    setTop((t) => (b.y < t ? b.y : b.y + b.h > t + rows ? Math.min(maxTop, b.y + b.h - rows) : t));
    setLeft((l) => (b.x < l ? b.x : b.x + b.w > l + inner ? Math.min(maxLeft, b.x + b.w - inner + 1) : l));
  }, [selected, drawn]);
  useInput((input, key) => {
    if (onSelect && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      return moveSelection(key.leftArrow ? -1 : key.rightArrow ? 1 : 0, key.upArrow ? -1 : key.downArrow ? 1 : 0);
    }
    if (onSelect && key.return && selected) return void onNode?.(selected, "enter");
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
    if (id && onNode?.(id, "click")) return;
    const ref = id ? chart.nodes.get(id)?.ref : null;
    if (ref) onOpenRef(ref);
  }, [click?.nonce]);

  // A drag between boxes: the box it started on, the box under the pointer now, and an arrow drawn when let go.
  const nodeAt = (p: { x: number; y: number } | null | undefined) => (p && drawn ? drawn.cells[top + p.y]?.[left + p.x]?.node ?? null : null);
  const dragFrom = drag ? nodeAt(drag.from) : null;
  const dragOver = drag?.to && dragFrom ? nodeAt(drag.to) : null;
  const target = dragOver && dragOver !== dragFrom ? dragOver : null;
  useEffect(() => {
    if (!drag?.done) return;
    if (dragFrom && target) onConnect?.(dragFrom, target, drag.alt);
    else onDragEnd?.();
  }, [drag?.done]);

  const kindOf = useMemo(() => new Map(drawn?.boxes.map((b) => [b.id, b.kind]) ?? []), [drawn]);
  const colorOf = (cell: Cell): { color: string; bold?: boolean; italic?: boolean } => {
    if (cell.style === "edge") return { color: C.dim };
    if (cell.style === "edgeLabel") return { color: C.dim, italic: true };
    const kind = cell.node ? kindOf.get(cell.node) ?? "plain" : "plain";
    // The selected box: heavier, in the highlight colour (its state still shows in its title); the box a drag
    // would connect to, too.
    if (cell.style === "border" && cell.node && (cell.node === selected || cell.node === target)) return { color: cell.node === target ? C.green : C.accent2, bold: true };
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
          const ch = cell.style === "border" && cell.node && (cell.node === selected || cell.node === target) ? HEAVY[cell.ch] ?? cell.ch : cell.ch;
          const last = runs.at(-1);
          if (last && last.look.color === look.color && last.look.bold === look.bold && last.look.italic === look.italic) last.text += ch;
          else runs.push({ text: ch, look });
        }
        return (
          <Text key={top + i} wrap="truncate-end">
            {runs.map((r, j) => <Text key={j} color={r.look.color} bold={!!r.look.bold} italic={!!r.look.italic}>{r.text}</Text>)}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      <Text wrap="truncate-end">
        {diagram.legend ? (
          <>
            {diagram.legend.map((l, i) => <Text key={i}><Text color={(C as Record<string, string>)[BORDER[l.kind]]!}>{i ? "" : " "}■</Text><Text color={C.dim}> {l.text} </Text></Text>)}
            <Text color={C.dim}>· </Text>
          </>
        ) : (
          <>
            <Text color={C.green}> ■</Text><Text color={C.dim}> new </Text>
            <Text color={C.yellow}>■</Text><Text color={C.dim}> changed · ↑↓←→ scroll · click a box: open its file · </Text>
          </>
        )}
        <Text color={C.text}>o</Text><Text color={C.dim}> browser{maxTop ? `  ${top + 1}-${Math.min(drawn.height, top + rows)}/${drawn.height}` : ""}</Text>
      </Text>
      {hint ? <Text color={C.dim} wrap="truncate-end"> {dragFrom && drag?.to ? (target ? "Let go to draw the arrow (Alt: with a condition) · drag off to cancel" : "Drag onto another chat to connect them") : hint}</Text> : null}
    </Pane>
  );
});
