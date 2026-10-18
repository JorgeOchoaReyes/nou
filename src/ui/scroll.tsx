import { Box, Text } from "ink";
import { C } from "./theme.js";

/**
 * Mouse wheel input for a pane, already added up: Nou collects the wheel events a terminal sends in a
 * burst (a fast flick or a trackpad sends dozens) and hands each pane one total per frame.
 * `lines` is how far to move (negative: up), `columns` the same sideways (Shift+wheel, or a tilt wheel).
 */
export type Wheel = { lines: number; columns: number; nonce: number };

/** A click or drag on a pane's scrollbar: `fraction` 0 is the top of the track, 1 the bottom. */
export type ScrollTo = { fraction: number; nonce: number };

/** Lines a single wheel notch moves. */
export const WHEEL_STEP = 3;

/** Where to scroll to for a scrollbar click at `fraction` of the track. */
export const topFor = (fraction: number, total: number, rows: number) =>
  Math.round(Math.max(0, Math.min(1, fraction)) * Math.max(0, total - rows));

/** The scrollbar thumb's first row and size for `rows` visible out of `total`, starting at `top`. */
export function thumb(total: number, top: number, rows: number): { start: number; size: number } {
  if (total <= rows) return { start: 0, size: rows };
  const size = Math.max(1, Math.round((rows / total) * rows));
  const maxTop = total - rows;
  const start = Math.round((Math.min(top, maxTop) / maxTop) * (rows - size));
  return { start, size };
}

/**
 * A one-column scrollbar beside a pane's content. Drawn only when there's more than fits; it keeps its
 * column either way so the content doesn't shift when it appears. One Text node for the whole column.
 */
export function Scrollbar({ total, top, rows, focused }: { total: number; top: number; rows: number; focused: boolean }) {
  if (total <= rows) return <Box width={1} flexShrink={0} />;
  const { start, size } = thumb(total, top, rows);
  // Only the thumb is drawn: a track beside the pane's border would read as a double line.
  const track = (n: number) => Array.from({ length: n }, () => " ").join("\n");
  const before = track(start);
  const after = track(rows - start - size);
  return (
    <Box width={1} flexShrink={0}>
      <Text>
        <Text color={C.dim}>{before}{before ? "\n" : ""}</Text>
        <Text color={focused ? C.accent : C.text}>{Array.from({ length: size }, () => "┃").join("\n")}</Text>
        <Text color={C.dim}>{after ? "\n" : ""}{after}</Text>
      </Text>
    </Box>
  );
}
