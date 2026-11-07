import { memo } from "react";
import path from "path";
import { Box, Text, useAnimation } from "ink";
import { C, gradient, ANIMATION_MS } from "./theme.js";
import { useTerminalFocused } from "./focus.js";
import { currentVersion } from "../update/index.js";
import type { WorkspaceTab } from "../workspaces/client.js";

const VERSION = `v${currentVersion()}`;
/** What comes before the project (or the workspace tabs): " ◆ NOU v1.2.3  │  ". */
const LEAD = ` ◆ NOU ${VERSION}  │  `;

const tabLabel = (t: WorkspaceTab, i: number) => ` ${i + 1} ${t.name}${t.busy ? " ●" : ""} `;
/** Each workspace tab ends with a × that closes it. */
const CLOSE = "× ";

/**
 * Where each workspace tab, and the + that opens one, sits in the header row: for clicks. With one workspace
 * (not hosted) there's just the project's name and the +.
 */
export function headerZones(tabs: WorkspaceTab[]): { from: number; to: number; tab: number | "new"; close?: boolean }[] {
  const zones: { from: number; to: number; tab: number | "new"; close?: boolean }[] = [];
  let x = LEAD.length;
  if (!tabs.length) {
    x += path.basename(process.cwd()).length + 1;
  } else {
    tabs.forEach((t, i) => {
      const w = tabLabel(t, i).length;
      zones.push({ from: x, to: x + w, tab: i });
      zones.push({ from: x + w, to: x + w + CLOSE.length, tab: i, close: true });
      x += w + CLOSE.length + 1;
    });
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
};

/**
 * The header's right side: the update notice (when there's room), where the model runs and which. Plain
 * characters only: symbols that are also emoji (☁, ⬆) are drawn two columns wide by some terminals.
 */
const rightSide = (width: number, model: string, local: boolean, update: string | null) => ({
  notice: update && width >= 110 ? `↑ v${update} available · run \`nou update\`  ` : "",
  badge: ` ${local ? "LOCAL" : "CLOUD"} `,
  model: ` ${model} `,
});

export const Header = memo(function Header({ width, branch, changes, model, local, busy, update, tabs = [] }: Props) {
  // The spinner stops while Nou's window is in the background: nobody sees it, and each frame is a redraw.
  const windowFocused = useTerminalFocused();
  const { frame } = useAnimation({ interval: ANIMATION_MS, isActive: !!busy && windowFocused });
  const project = path.basename(process.cwd());
  const right = rightSide(width, model, local, update);
  const rightWidth = right.notice.length + right.badge.length + right.model.length + 1;
  return (
    <Box width={width} justifyContent="space-between">
      {/* The left side gets what the right leaves, less a margin, and is cut short: the row never wraps, even
          where the terminal draws a symbol or two wider than counted (a wrapped header pushes the whole screen
          down a row, and every click lands a row off). */}
      <Box width={Math.max(0, width - rightWidth - 4)} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">
          {" "}
          {gradient("◆ NOU", busy ? frame : 0).map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
          <Text color={C.dim}> {VERSION}</Text>
          <Text color={C.dim}>  │  </Text>
          {tabs.length
            ? tabs.map((t, i) => (
              <Text key={t.id}>
                <Text {...(t.active ? { backgroundColor: C.panel } : {})} color={t.active ? C.accent : C.text} bold={t.active}>{tabLabel(t, i)}</Text>
                <Text {...(t.active ? { backgroundColor: C.panel } : {})} color={C.dim}>{CLOSE}</Text>
                {" "}
              </Text>
            ))
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
