import { Fragment } from "react";
import path from "path";
import { Text } from "ink";
import { C, fileIcon } from "./theme.js";

/** Where each tab sits in the title row, in columns from the row's start, for clicks. */
export type TabZone = { file: string; from: number; to: number; close: number | null };

/** Tab labels: file names, with the folder added when two open files share a name. */
function labels(tabs: string[]): string[] {
  return tabs.map((file) => {
    const name = path.posix.basename(file);
    const twin = tabs.some((other) => other !== file && path.posix.basename(other) === name);
    return twin ? `${path.posix.basename(path.posix.dirname(file))}/${name}` : name;
  });
}

/**
 * Lays out the tabs that fit in `width` columns, keeping the active one in view: the ones that don't fit
 * are left out at the ends, marked with ‹ ›.
 */
export function layoutTabs(tabs: string[], active: string | null, width: number): { shown: { file: string; label: string }[]; before: boolean; after: boolean; zones: TabZone[] } {
  const all = labels(tabs).map((label, i) => ({ file: tabs[i]!, label }));
  const size = (t: { file: string; label: string }) => t.label.length + 4 + (t.file === active ? 2 : 0) + 1; // " ◆ name × " and "│"
  const at = Math.max(0, all.findIndex((t) => t.file === active));
  let from = at;
  let to = at + 1;
  let used = all[at] ? size(all[at]) : 0;
  // Grow to the right, then to the left, while there's room (2 columns kept for ‹ ›).
  for (let grew = true; grew;) {
    grew = false;
    if (to < all.length && used + size(all[to]!) <= width - 2) {
      used += size(all[to++]!);
      grew = true;
    }
    if (from > 0 && used + size(all[from - 1]!) <= width - 2) {
      used += size(all[--from]!);
      grew = true;
    }
  }
  const shown = all.slice(from, to);
  const zones: TabZone[] = [];
  let x = from > 0 ? 1 : 0;
  for (const t of shown) {
    const w = size(t) - 1;
    zones.push({ file: t.file, from: x, to: x + w, close: t.file === active ? x + w - 2 : null });
    x += w + 1;
  }
  return { shown, before: from > 0, after: to < all.length, zones };
}

/** The open files as tabs, for a pane's title row: the active one highlighted, with × to close it. */
export function Tabs({ tabs, active, width, dirty }: { tabs: string[]; active: string | null; width: number; dirty?: boolean }) {
  const { shown, before, after } = layoutTabs(tabs, active, width);
  return (
    <>
      {before ? <Text color={C.dim}>‹</Text> : null}
      {shown.map((t) => {
        const on = t.file === active;
        const { icon, color } = fileIcon(t.file);
        return (
          <Fragment key={t.file}>
            <Text {...(on ? { backgroundColor: C.panel } : {})}>
              <Text> </Text>
              <Text color={color}>{icon}</Text>
              <Text color={on ? C.text : C.dim} bold={on}> {t.label}</Text>
              {on ? <Text color={dirty ? C.yellow : C.dim}> {dirty ? "●" : "×"}</Text> : null}
              <Text> </Text>
            </Text>
            <Text color={C.dim}>│</Text>
          </Fragment>
        );
      })}
      {after ? <Text color={C.dim}>›</Text> : null}
    </>
  );
}
