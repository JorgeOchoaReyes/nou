import { useEffect, useMemo, useState } from "react";
import { readdirSync } from "fs";
import path from "path";
import { Box, Text, useInput } from "ink";
import { IGNORED } from "../commands/index.js";
import { Pane } from "./Pane.js";

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
  changed: Set<string>;
  onOpen(filePath: string): void;
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

export function FileTree({ width, height, focused, openFile, reveal, version, changed, onOpen }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  const [cursor, setCursor] = useState(0);
  const nodes = useMemo(() => flatten(expanded), [expanded, version]);
  const rows = Math.max(1, height - 3);

  // Expand the folders leading to whatever the agent is touching and move to it.
  useEffect(() => {
    if (!reveal) return;
    const parts = reveal.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [reveal, version]);

  useEffect(() => {
    if (!reveal) return;
    const index = nodes.findIndex((n) => n.path === reveal);
    if (index >= 0) setCursor(index);
  }, [nodes, reveal]);

  const toggle = (dir: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(dir)) next.add(dir);
      else next.delete(dir);
      return next;
    });

  useInput((input, key) => {
    const node = nodes[cursor];
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(nodes.length - 1, c + 1));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - rows));
    else if (key.pageDown) setCursor((c) => Math.min(nodes.length - 1, c + rows));
    else if (!node) return;
    else if (key.return || key.rightArrow || input === "l") {
      if (node.isDir) toggle(node.path, key.return ? undefined : true);
      else onOpen(node.path);
    } else if (key.leftArrow || input === "h") {
      if (node.isDir && expanded.has(node.path)) toggle(node.path, false);
      else {
        const parent = node.path.split("/").slice(0, -1).join("/");
        const index = nodes.findIndex((n) => n.path === parent);
        if (index >= 0) setCursor(index);
      }
    }
  }, { isActive: focused });

  const start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), nodes.length - rows));
  const visible = nodes.slice(start, start + rows);

  return (
    <Pane title=" Files" width={width} height={height} focused={focused}>
      <Box flexDirection="column">
        {visible.map((node, i) => {
          const selected = start + i === cursor;
          const icon = node.isDir ? (expanded.has(node.path) ? "▾ " : "▸ ") : "  ";
          const color = node.path === openFile ? "cyan" : changed.has(node.path) ? "green" : node.isDir ? "blue" : undefined;
          return (
            <Text key={node.path} wrap="truncate-end" inverse={selected && focused} {...(color ? { color } : {})}>
              {"  ".repeat(node.depth)}{icon}{node.name}{changed.has(node.path) ? " ●" : ""}
            </Text>
          );
        })}
      </Box>
    </Pane>
  );
}
