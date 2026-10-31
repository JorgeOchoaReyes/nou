import { memo, useEffect, useMemo, useRef, useState } from "react";
import { readdirSync } from "fs";
import path from "path";
import { Box, Text, useAnimation, useInput } from "ink";
import { IGNORED } from "../commands/index.js";
import type { GitStatus } from "../git/index.js";
import { C, GIT_COLORS, fileIcon, gradient, ANIMATION_MS } from "./theme.js";
import { Pane } from "./Pane.js";
import { Scrollbar, topFor, type ScrollTo, type Wheel } from "./scroll.js";

type Node = { path: string; name: string; depth: number; isDir: boolean };

type Props = {
  width: number;
  height: number;
  focused: boolean;
  openFile: string | null;
  /** Path the agent is working on; the tree expands to show it. */
  reveal: string | null;
  /** Bump to re-read the disk (e.g. after a file is created). */
  version: number;
  /** Files Nou edited this session. */
  changed: Set<string>;
  /** Files Nou is editing right now (this turn): their names shimmer. */
  working?: Set<string>;
  git: GitStatus;
  /** Problem counts per file, from the checkers. */
  problemCounts: Map<string, { errors: number; warnings: number }>;
  wheel?: Wheel | null;
  /** A click or drag on the scrollbar. */
  scrollTo?: ScrollTo | null;
  /** A click on a visible row (0 = first row under the title). */
  click?: { row: number; nonce: number } | null;
  onOpen(filePath: string): void;
  onHover(filePath: string | null): void;
};

function listDir(dir: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true })
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function flatten(expanded: Set<string>): Node[] {
  const nodes: Node[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of listDir(dir)) {
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      nodes.push({ path: rel, name: entry.name, depth, isDir: entry.isDir });
      if (entry.isDir && expanded.has(rel)) walk(rel, depth + 1);
    }
  };
  walk(".", 0);
  return nodes;
}

export const FileTree = memo(function FileTree({ width, height, focused, openFile, reveal, version, changed, working, git, problemCounts, wheel, scrollTo, click, onOpen, onHover }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  const [cursor, setCursor] = useState(0);
  // The first row shown. The wheel moves it on its own; the keyboard moves the cursor and the view follows.
  const [top, setTop] = useState(0);
  const [changesOnly, setChangesOnly] = useState(false);

  // Reading folders hits the disk, so only redo it when something that changes the list changes.
  const all = useMemo(() => (changesOnly ? null : flatten(expanded)), [expanded, version, changesOnly]);
  const nodes = useMemo(
    () => all ?? [...new Set([...git.keys(), ...changed])].sort().map((p) => ({ path: p, name: p, depth: 0, isDir: false })),
    [all, changesOnly ? git : null, changesOnly ? changed : null],
  );
  const rows = Math.max(1, height - 3);
  const maxTop = Math.max(0, nodes.length - rows);

  // Keep the cursor in view when it moves (keyboard, reveal, click), not when the wheel scrolls.
  const follow = useRef(true);
  useEffect(() => {
    if (!follow.current) return;
    setTop((t) => (cursor < t ? Math.max(0, cursor - 2) : cursor >= t + rows ? Math.min(maxTop, cursor - rows + 3) : Math.min(t, maxTop)));
  }, [cursor, rows, maxTop]);
  const moveCursor = (fn: (c: number) => number) => {
    follow.current = true;
    setCursor(fn);
  };

  // Folders that contain git changes get a dot.
  const dirtyDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const file of git.keys()) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [git]);

  // Expand the folders leading to whatever the agent is touching and move to it, once per reveal:
  // later changes to the list (expanding folders, git refreshes) must not pull the cursor back.
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    if (!reveal) return;
    pendingReveal.current = reveal;
    const parts = reveal.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [reveal, version]);

  useEffect(() => {
    if (!pendingReveal.current) return;
    const index = nodes.findIndex((n) => n.path === pendingReveal.current);
    if (index < 0) return;
    moveCursor(() => index);
    pendingReveal.current = null;
  }, [nodes]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, nodes.length - 1)));
  }, [nodes.length]);

  useEffect(() => {
    onHover(focused ? nodes[cursor]?.path ?? null : null);
  }, [focused, cursor, nodes]);

  const toggle = (dir: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(dir)) next.add(dir);
      else next.delete(dir);
      return next;
    });

  useInput((input, key) => {
    const node = nodes[cursor];
    if (input === "c") {
      setChangesOnly((v) => !v);
      moveCursor(() => 0);
    } else if (key.upArrow || input === "k") moveCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") moveCursor((c) => Math.min(nodes.length - 1, c + 1));
    else if (key.pageUp) moveCursor((c) => Math.max(0, c - rows));
    else if (key.pageDown) moveCursor((c) => Math.min(nodes.length - 1, c + rows));
    else if (key.home || input === "g") moveCursor(() => 0);
    else if (key.end || input === "G") moveCursor(() => Math.max(0, nodes.length - 1));
    else if (!node) return;
    else if (key.return || key.rightArrow || input === "l") {
      if (node.isDir) toggle(node.path, key.return ? undefined : true);
      else onOpen(node.path);
    } else if (key.leftArrow || input === "h") {
      if (node.isDir && expanded.has(node.path)) toggle(node.path, false);
      else {
        const parent = node.path.split("/").slice(0, -1).join("/");
        const index = nodes.findIndex((n) => n.path === parent);
        if (index >= 0) moveCursor(() => index);
      }
    }
  }, { isActive: focused });

  const start = Math.min(top, maxTop);
  const visible = nodes.slice(start, start + rows);

  // The wheel scrolls the list; the selection stays where it is.
  useEffect(() => {
    if (!wheel?.lines) return;
    follow.current = false;
    setTop((t) => Math.max(0, Math.min(maxTop, Math.min(t, maxTop) + wheel.lines)));
  }, [wheel?.nonce]);
  useEffect(() => {
    if (!scrollTo) return;
    follow.current = false;
    setTop(topFor(scrollTo.fraction, nodes.length, rows));
  }, [scrollTo?.nonce]);

  // Clicking a row selects it; a file opens, a folder expands or collapses.
  useEffect(() => {
    if (!click) return;
    const node = visible[click.row];
    if (!node) return;
    follow.current = false; // already on screen: don't jump the view
    setCursor(start + click.row);
    if (node.isDir) toggle(node.path);
    else onOpen(node.path);
  }, [click?.nonce]);
  const { frame } = useAnimation({ interval: ANIMATION_MS, isActive: !!working?.size });
  const inner = width - 3; // minus the borders and the scrollbar
  const title = changesOnly
    ? <> <Text color={C.yellow}>±</Text> Changes <Text color={C.dim}>({nodes.length})  c: all files</Text></>
    : <> <Text color={C.accent}>▤</Text> Explorer{git.size ? <Text color={C.dim}>{inner >= 30 ? `  c: changes (${git.size})` : `  ±${git.size}`}</Text> : null}</>;

  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={inner} flexShrink={0}>
          {visible.length === 0 && <Text color={C.dim}>  {changesOnly ? "No changes ✓" : "(empty)"}</Text>}
          {visible.map((node, i) => {
            const selected = start + i === cursor;
            const code = git.get(node.path);
            const isOpen = node.path === openFile;
            const { icon, color } = node.isDir
              ? { icon: expanded.has(node.path) ? "▾" : "▸", color: C.accent }
              : fileIcon(node.path);
            const counts = problemCounts.get(node.path);
            const problemMark = counts?.errors ? "✖" : counts?.warnings ? "▲" : "";
            const marker = problemMark || code || (changed.has(node.path) ? "●" : dirtyDirs.has(node.path) ? "•" : "");
            const markerColor = counts?.errors ? C.red : counts?.warnings ? C.yellow : code ? GIT_COLORS[code] ?? C.yellow : changed.has(node.path) ? C.green : C.yellow;
            const label = `${"  ".repeat(node.depth)}${icon} ${node.name}`;
            const nameColor = isOpen ? C.cyan : counts?.errors ? C.red : code ? GIT_COLORS[code] : node.isDir ? C.text : undefined;
            const room = Math.max(1, inner - marker.length - 1);
            const shown = label.length > room ? `${label.slice(0, room - 1)}…` : label.padEnd(room);
            const iconAt = shown.indexOf(icon);
            return (
              <Text key={node.path} wrap="truncate-end" {...(selected && focused ? { backgroundColor: C.panel } : {})}>
                <Text {...(nameColor ? { color: nameColor } : {})} bold={isOpen}>{shown.slice(0, iconAt)}</Text>
                <Text color={color}>{shown.slice(iconAt, iconAt + icon.length)}</Text>
                {working?.has(node.path) ? (
                  <Text bold inverse={selected && focused}>
                    {gradient(shown.slice(iconAt + icon.length), frame).map((g, j) => <Text key={j} color={g.color}>{g.ch}</Text>)}
                  </Text>
                ) : (
                  <Text {...(nameColor ? { color: nameColor } : {})} bold={isOpen} inverse={selected && focused}>{shown.slice(iconAt + icon.length)}</Text>
                )}
                <Text color={markerColor}> {marker}</Text>
              </Text>
            );
          })}
        </Box>
        <Scrollbar total={nodes.length} top={start} rows={rows} focused={focused} />
      </Box>
    </Pane>
  );
});
