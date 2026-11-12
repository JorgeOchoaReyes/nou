import { memo } from "react";
import path from "path";
import { Box, Text, useAnimation } from "ink";
import { C, gradient, ANIMATION_MS } from "./theme.js";
import { useTerminalFocused } from "./focus.js";
import { currentVersion } from "../update/index.js";
import type { WorkspaceTab } from "../workspaces/client.js";
import { fitAround } from "./Tabs.js";

const VERSION = `v${currentVersion()}`;
/** What comes before the project (or the workspace tabs): " ◆ NOU v1.2.3  │  ". */
const LEAD = ` ◆ NOU ${VERSION}  │  `;

const tabLabel = (t: WorkspaceTab, i: number) => ` ${i + 1} ${t.name}${t.busy ? " ●" : ""} `;
/** Each workspace tab ends with a × that closes it. */
const CLOSE = "× ";

/** The markers for workspace tabs that don't fit: click to go to the one before or after. */
const PREV = "‹ ";
const NEXT = "› ";

/**
 * The header's right side: the update notice (when there's room), where the model runs and which. Plain
 * characters only: symbols that are also emoji (☁, ⬆) are drawn two columns wide by some terminals.
 */
const rightSide = (width: number, model: string, local: boolean, update: string | null) => ({
  notice: update && width >= 110 ? `↑ v${update} available · run \`nou update\`  ` : "",
  badge: ` ${local ? "LOCAL" : "CLOUD"} `,
  model: ` ${model} `,
});

/** Columns the left side of the header gets: what the right leaves, less a margin. */
const leftWidth = (width: number, model: string, local: boolean, update: string | null) => {
  const right = rightSide(width, model, local, update);
  return Math.max(0, width - (right.notice.length + right.badge.length + right.model.length + 1) - 4);
};

/**
 * Which workspace tabs the header shows, around the active one: as many as fit, with ‹ › for the rest (the
 * + always shows). The drawing and the clicks both use it.
 */
export function headerLayout(tabs: WorkspaceTab[], width: number, model: string, local: boolean, update: string | null) {
  const room = leftWidth(width, model, local, update) - LEAD.length - 3 - 2; // " + " and a little air
  const sizes = tabs.map((t, i) => tabLabel(t, i).length + CLOSE.length + 1);
  const { from, to } = fitAround(sizes, tabs.findIndex((t) => t.active), room, PREV.length + NEXT.length);
  return { from, to, before: from > 0, after: to < tabs.length };
}

/**
 * Where each workspace tab, its ×, the ‹ › and the + that opens one sit in the header row: for clicks. With
 * one workspace (not hosted) there's just the project's name and the +.
 */
export function headerZones(tabs: WorkspaceTab[], width = 10_000, model = "", local = true, update: string | null = null, project = path.basename(process.cwd())): { from: number; to: number; tab: number | "new"; close?: boolean }[] {
  const zones: { from: number; to: number; tab: number | "new"; close?: boolean }[] = [];
  let x = LEAD.length;
  if (!tabs.length) {
    x += project.length + 1;
  } else {
    const { from, to, before, after } = headerLayout(tabs, width, model, local, update);
    if (before) {
      zones.push({ from: x, to: x + PREV.length, tab: from - 1 });
      x += PREV.length;
    }
    for (let i = from; i < to; i++) {
      const w = tabLabel(tabs[i]!, i).length;
      zones.push({ from: x, to: x + w, tab: i });
      zones.push({ from: x + w, to: x + w + CLOSE.length, tab: i, close: true });
      x += w + CLOSE.length + 1;
    }
    if (after) {
      zones.push({ from: x, to: x + NEXT.length, tab: to });
      x += NEXT.length;
    }
  }
  zones.push({ from: x, to: x + 3, tab: "new" });
  return zones;
}

type Props = {
  width: number;
  branch: string | null;
  changes: number;
  model: string;
  local: boolean;
  busy: string | null;
  /** Newer version on npm, if any. */
  update: string | null;
  /** The workspaces in this window when there are several (a tab each), else empty. */
  tabs?: WorkspaceTab[];
  /** What a single workspace's header calls it (its folder's name unless renamed). */
  project?: string;
};

export const Header = memo(function Header({ width, branch, changes, model, local, busy, update, tabs = [], project = path.basename(process.cwd()) }: Props) {
  // The spinner stops while Nou's window is in the background: nobody sees it, and each frame is a redraw.
  const windowFocused = useTerminalFocused();
  const { frame } = useAnimation({ interval: ANIMATION_MS, isActive: !!busy && windowFocused });
  const right = rightSide(width, model, local, update);
  const shown = headerLayout(tabs, width, model, local, update);
  return (
    <Box width={width} justifyContent="space-between">
      {/* The left side gets what the right leaves, less a margin, and is cut short: the row never wraps, even
          where the terminal draws a symbol or two wider than counted (a wrapped header pushes the whole screen
          down a row, and every click lands a row off). */}
      <Box width={leftWidth(width, model, local, update)} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">
          {" "}
          {gradient("◆ NOU", busy ? frame : 0).map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
          <Text color={C.dim}> {VERSION}</Text>
          <Text color={C.dim}>  │  </Text>
          {tabs.length
            ? <>
              {shown.before ? <Text color={C.accent}>{PREV}</Text> : null}
              {tabs.slice(shown.from, shown.to).map((t, j) => (
                <Text key={t.id}>
                  <Text {...(t.active ? { backgroundColor: C.panel } : {})} color={t.active ? C.accent : C.text} bold={t.active}>{tabLabel(t, shown.from + j)}</Text>
                  <Text {...(t.active ? { backgroundColor: C.panel } : {})} color={C.dim}>{CLOSE}</Text>
                  {" "}
                </Text>
              ))}
              {shown.after ? <Text color={C.accent}>{NEXT}</Text> : null}
            </>
            : <Text color={C.text}>{project} </Text>}
          <Text color={C.accent2}> + </Text>
          {branch && (
            <>
              <Text color={C.dim}>  │  </Text>
              <Text color={C.accent2}>⎇ {branch}</Text>
              {changes > 0 && <Text color={C.yellow}> ±{changes}</Text>}
            </>
          )}
        </Text>
      </Box>
      {/* The model badge never wraps or shrinks: the left side gives way instead. */}
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          {right.notice && <Text color={C.green} bold>{right.notice}</Text>}
          <Text backgroundColor={local ? C.green : C.accent2} color={C.onBadge} bold>{right.badge}</Text>
          <Text backgroundColor={C.panel} color={C.text}>{right.model}</Text>
          {" "}
        </Text>
      </Box>
    </Box>
  );
});
