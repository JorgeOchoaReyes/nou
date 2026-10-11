import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { highlightLines } from "./text.js";
import { C, fileIcon } from "./theme.js";
import { Pane } from "./Pane.js";

export type EditorState = { line: number; col: number; dirty: boolean; lines: string[] };

type Props = {
  width: number;
  height: number;
  focused: boolean;
  filePath: string;
  /** Text to start editing from (may be an unsaved draft). */
  initial: string;
  /** The text on disk, to tell whether there are unsaved changes. */
  baseline: string;
  onSave(text: string): void;
  onExit(): void;
  onState(state: EditorState): void;
};

type Buffer = { lines: string[]; row: number; col: number };

const expand = (s: string) => s.replace(/\t/g, "  ");

/** A small modal text editor: arrows to move, type to insert, Ctrl+S save, Ctrl+Z undo, Esc leave. */
export function Editor({ width, height, focused, filePath, initial, baseline, onSave, onExit, onState }: Props) {
  const eol = useMemo(() => (baseline.includes("\r\n") ? "\r\n" : "\n"), [baseline]);
  const indentUnit = useMemo(() => (/^\t/m.test(initial) ? "\t" : "  "), [initial]);
  const [buf, setBuf] = useState<Buffer>(() => ({ lines: initial.replace(/\r\n/g, "\n").split("\n"), row: 0, col: 0 }));
  const [saved, setSaved] = useState(() => baseline.replace(/\r\n/g, "\n"));
  const [confirmExit, setConfirmExit] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const undo = useRef<Buffer[]>([]);
  const view = useRef({ top: 0, left: 0 });

  const dirty = useMemo(() => buf.lines.join("\n") !== saved, [buf.lines, saved]);
  useEffect(() => onState({ line: buf.row + 1, col: buf.col + 1, dirty, lines: buf.lines }), [buf, dirty]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const edit = (fn: (b: Buffer) => Buffer) =>
    setBuf((b) => {
      undo.current.push(b);
      if (undo.current.length > 300) undo.current.shift();
      return fn(b);
    });

  const insert = (text: string) =>
    edit((b) => {
      const pieces = text.replace(/\r\n?/g, "\n").split("\n");
      const line = b.lines[b.row]!;
      const before = line.slice(0, b.col);
      const after = line.slice(b.col);
      const lines = [...b.lines];
      if (pieces.length === 1) {
        lines[b.row] = before + text + after;
        return { lines, row: b.row, col: b.col + text.length };
      }
      const last = pieces[pieces.length - 1]!;
      lines.splice(b.row, 1, before + pieces[0], ...pieces.slice(1, -1), last + after);
      return { lines, row: b.row + pieces.length - 1, col: last.length };
    });

  const move = (fn: (b: Buffer) => Partial<Buffer>) =>
    setBuf((b) => {
      const next = { ...b, ...fn(b) };
      next.row = Math.max(0, Math.min(next.lines.length - 1, next.row));
      next.col = Math.max(0, Math.min(next.lines[next.row]!.length, next.col));
      return next;
    });

  const save = () => {
    const text = buf.lines.join("\n");
    onSave(text.replace(/\n/g, eol));
    setSaved(text);
    setFlash("Saved ✓");
  };

  const rows = Math.max(1, height - 4);

  usePaste((text) => insert(text), { isActive: focused });

  useInput((input, key) => {
    if (confirmExit) {
      if (key.escape) onExit();
      else if (key.ctrl && input === "s") {
        save();
        onExit();
      } else setConfirmExit(false);
      return;
    }
    if (key.ctrl && input === "s") return save();
    if (key.ctrl && input === "z") {
      const prev = undo.current.pop();
      if (prev) setBuf(prev);
      return;
    }
    if (key.escape) return dirty ? setConfirmExit(true) : onExit();

    if (key.upArrow) return move((b) => ({ row: b.row - 1 }));
    if (key.downArrow) return move((b) => ({ row: b.row + 1 }));
    if (key.leftArrow) {
      return move((b) => (b.col > 0 ? { col: b.col - 1 } : b.row > 0 ? { row: b.row - 1, col: b.lines[b.row - 1]!.length } : {}));
    }
    if (key.rightArrow) {
      return move((b) => (b.col < b.lines[b.row]!.length ? { col: b.col + 1 } : b.row < b.lines.length - 1 ? { row: b.row + 1, col: 0 } : {}));
    }
    if (key.home) return move((b) => ({ col: b.lines[b.row]!.match(/^\s*/)![0].length === b.col ? 0 : b.lines[b.row]!.match(/^\s*/)![0].length }));
    if (key.end) return move((b) => ({ col: b.lines[b.row]!.length }));
    if (key.pageUp) return move((b) => ({ row: b.row - rows }));
    if (key.pageDown) return move((b) => ({ row: b.row + rows }));

    if (key.return) {
      const indent = buf.lines[buf.row]!.match(/^\s*/)![0];
      return insert(`\n${indent}`);
    }
    if (key.tab) return insert(indentUnit);
    if (key.backspace) {
      return edit((b) => {
        const lines = [...b.lines];
        if (b.col > 0) {
          const line = lines[b.row]!;
          lines[b.row] = line.slice(0, b.col - 1) + line.slice(b.col);
          return { lines, row: b.row, col: b.col - 1 };
        }
        if (b.row === 0) return b;
        const prev = lines[b.row - 1]!;
        lines.splice(b.row - 1, 2, prev + lines[b.row]);
        return { lines, row: b.row - 1, col: prev.length };
      });
    }
    if (key.delete) {
      return edit((b) => {
        const lines = [...b.lines];
        const line = lines[b.row]!;
        if (b.col < line.length) lines[b.row] = line.slice(0, b.col) + line.slice(b.col + 1);
        else if (b.row < lines.length - 1) lines.splice(b.row, 2, line + lines[b.row + 1]);
        return { ...b, lines };
      });
    }
    if (input && !key.ctrl && !key.meta) insert(input);
  }, { isActive: focused });

  // Keep the cursor on screen.
  const gutter = String(buf.lines.length).length + 2;
  const textWidth = Math.max(10, width - 2 - gutter);
  const v = view.current;
  if (buf.row < v.top) v.top = buf.row;
  if (buf.row >= v.top + rows) v.top = buf.row - rows + 1;
  const cursorX = expand(buf.lines[buf.row]!.slice(0, buf.col)).length;
  if (cursorX < v.left) v.left = Math.max(0, cursorX - 8);
  if (cursorX >= v.left + textWidth) v.left = cursorX - textWidth + 8;

  const visible = buf.lines.slice(v.top, v.top + rows);
  const colored = useMemo(
    () => (v.left === 0 ? highlightLines(filePath, visible.join("\n")) : visible.map(expand)),
    [filePath, visible.join("\n"), v.left],
  );

  const { icon, color } = fileIcon(filePath);
  const status = confirmExit
    ? "Unsaved changes! Ctrl+S save & close · Esc discard · any key keep editing"
    : flash ?? `Ln ${buf.row + 1}, Col ${buf.col + 1}${dirty ? "  ● modified" : ""}`;

  return (
    <Pane title={<> <Text color={color}>{icon}</Text> {filePath}{dirty ? <Text color={C.yellow}> ●</Text> : ""}  <Text backgroundColor={C.green} color="black"> ✎ EDITING </Text></>} width={width} height={height} focused={focused} accent={C.green}>
      <Box flexDirection="column" height={rows}>
        {visible.map((line, i) => {
          const n = v.top + i;
          const isCursorLine = n === buf.row;
          const num = <Text color={isCursorLine ? C.green : C.dim}>{String(n + 1).padStart(gutter - 2)}{isCursorLine ? " ▸" : "  "}</Text>;
          if (!isCursorLine) {
            return <Text key={n} wrap="truncate-end">{num}{colored[i] || " "}</Text>;
          }
          const shown = expand(line).slice(v.left, v.left + textWidth);
          const at = cursorX - v.left;
          return (
            <Text key={n} wrap="truncate-end">
              {num}
              <Text color={C.text}>{shown.slice(0, at)}</Text>
              <Text inverse color={C.green}>{shown[at] ?? " "}</Text>
              <Text color={C.text}>{shown.slice(at + 1)}</Text>
            </Text>
          );
        })}
      </Box>
      <Text wrap="truncate-end" color={confirmExit ? C.red : flash ? C.green : C.dim}>
        {` ${status}`}<Text color={C.dim}>{confirmExit ? "" : "   Ctrl+S save · Ctrl+Z undo · Esc close"}</Text>
      </Text>
    </Pane>
  );
}
