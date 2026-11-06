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

/**
 * Where each workspace tab, and the + that opens one, sits in the header row: for clicks. With one workspace
 * (not hosted) there's just the project's name and the +.
 */
export function headerZones(tabs: WorkspaceTab[]): { from: number; to: number; tab: number | "new" }[] {
  const zones: { from: number; to: number; tab: number | "new" }[] = [];
  let x = LEAD.length;
  if (!tabs.length) {
    x += path.basename(process.cwd()).length + 1;
  } else {
    tabs.forEach((t, i) => {
      const w = tabLabel(t, i).length;
      zones.push({ from: x, to: x + w, tab: i });
      x += w + 1;
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

export const Header = memo(function Header({ width, branch, changes, model, local, busy, update, tabs = [] }: Props) {
  // The spinner stops while Nou's window is in the background: nobody sees it, and each frame is a redraw.
  const windowFocused = useTerminalFocused();
  const { frame } = useAnimation({ interval: ANIMATION_MS, isActive: !!busy && windowFocused });
  const project = path.basename(process.cwd());
  return (
    <Box width={width} justifyContent="space-between">
      <Box flexShrink={1} flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end">
          {" "}
          {gradient("◆ NOU", busy ? frame : 0).map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
          <Text color={C.dim}> {VERSION}</Text>
          <Text color={C.dim}>  │  </Text>
          {tabs.length
            ? tabs.map((t, i) => (
              <Text key={t.id}>
                <Text {...(t.active ? { backgroundColor: C.panel } : {})} color={t.active ? C.accent : C.text} bold={t.active}>{tabLabel(t, i)}</Text>
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
          {update && width >= 110 && <Text color={C.green} bold>⬆ v{update} available · run `nou update`  </Text>}
          <Text backgroundColor={local ? C.green : C.accent2} color={C.onBadge} bold>{` ${local ? "⌂ LOCAL" : "☁ CLOUD"} `}</Text>
          <Text backgroundColor={C.panel} color={C.text}>{` ${model} `}</Text>
          {" "}
        </Text>
      </Box>
    </Box>
  );
});
