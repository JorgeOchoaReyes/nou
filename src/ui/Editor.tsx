import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import path from "path";
import { Box, Text, useInput, usePaste } from "ink";
import type { AutoSave } from "../config/index.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { highlightLines, sliceAnsi } from "./text.js";
import { C, fileIcon } from "./theme.js";
import { SEVERITY_STYLE } from "./ProblemsView.js";
import { Pane } from "./Pane.js";
import { Scrollbar, topFor, type ScrollTo, type Wheel } from "./scroll.js";
import { copyToClipboard, readClipboard } from "./clipboard.js";
import { guideProgress } from "../guide/index.js";

export type EditorState = { line: number; col: number; dirty: boolean; lines: string[]; selection: boolean };

/**
 * A mouse press, drag or release over the editor, in cells from the top-left of its text area (gutter
 * included). `seq` counts up: a quick click's press and release often arrive together, so the editor
 * gets the recent events as a list and handles each one it hasn't seen yet.
 */
/** "define": Ctrl/Alt+click or right-click, go to the definition of what's under the pointer. */
export type EditorMouse = { x: number; y: number; kind: "press" | "double" | "drag" | "release" | "define"; seq: number };

type Props = {
  width: number;
  height: number;
  focused: boolean;
  filePath: string;
  /** Text to start editing from (may be an unsaved draft). */
  initial: string;
  /** The text on disk, to tell whether there are unsaved changes. */
  baseline: string;
  /** Line (1-based) to put the cursor on when opening (e.g. from the Problems list or go-to-definition). */
  startLine?: number;
  /** Column (1-based) on that line, e.g. where you clicked in the code view. */
  startCol?: number;
  problems: Diagnostic[];
  autoSave: AutoSave;
  syntaxVersion: number;
  wheel?: Wheel | null;
  scrollTo?: ScrollTo | null;
  mouse?: EditorMouse[];
  onSave(text: string): void;
  onExit(): void;
  onState(state: EditorState): void;
  /** Hover info for the symbol at a position (language servers). */
  onHover(text: string, line: number, col: number): Promise<string | null>;
  /** Jump to where the symbol at a position is defined. */
  onDefinition(text: string, line: number, col: number): void;
  /** The open files as tabs, shown in the title row instead of the file's path. */
  tabs?: ReactNode;
  /**
   * "Show me how": code for you to type before line `row` (0-based). A new line opens there, the code
   * still to type shows dim ahead of the cursor (Tab fills in the rest of the line), and `onGuideDone`
   * runs once it's all typed.
   */
  guide?: { row: number; code: string } | null;
  onGuideDone?(): void;
};

type Pos = { row: number; col: number };
/** The text, the cursor, and where a selection started (null: nothing selected). */
type Buffer = { lines: string[]; row: number; col: number; anchor: Pos | null };

const TAB = "  ";
const expand = (s: string) => s.replace(/\t/g, TAB);
/** Screen column of buffer column `col` on `line` (tabs take two cells). */
const screenCol = (line: string, col: number) => expand(line.slice(0, col)).length;
/** Buffer column at screen column `x` on `line`. */
function bufferCol(line: string, x: number): number {
  let cells = 0;
  for (let i = 0; i < line.length; i++) {
    cells += line[i] === "\t" ? TAB.length : 1;
    if (cells > x) return i;
  }
  return line.length;
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col);
/** The selection as start and end positions, or null when nothing is selected. */
function selection(b: Buffer): { start: Pos; end: Pos } | null {
  if (!b.anchor || (b.anchor.row === b.row && b.anchor.col === b.col)) return null;
  const cursor = { row: b.row, col: b.col };
  return before(b.anchor, cursor) ? { start: b.anchor, end: cursor } : { start: cursor, end: b.anchor };
}
function selectedText(b: Buffer): string {
  const sel = selection(b);
  if (!sel) return "";
  if (sel.start.row === sel.end.row) return b.lines[sel.start.row]!.slice(sel.start.col, sel.end.col);
  return [
    b.lines[sel.start.row]!.slice(sel.start.col),
    ...b.lines.slice(sel.start.row + 1, sel.end.row),
    b.lines[sel.end.row]!.slice(0, sel.end.col),
  ].join("\n");
}
/** The buffer with the selection removed and the cursor where it began. */
function deleteSelection(b: Buffer): Buffer {
  const sel = selection(b);
  if (!sel) return { ...b, anchor: null };
  const lines = [...b.lines];
  const merged = lines[sel.start.row]!.slice(0, sel.start.col) + lines[sel.end.row]!.slice(sel.end.col);
  lines.splice(sel.start.row, sel.end.row - sel.start.row + 1, merged);
  return { lines, row: sel.start.row, col: sel.start.col, anchor: null };
}
/** Rows a line-wise command (indent, comment, move) applies to: the selected lines, or the cursor's. */
function selectedRows(b: Buffer): [number, number] {
  const sel = selection(b);
  if (!sel) return [b.row, b.row];
  // A selection ending at the very start of a line doesn't include that line.
  return [sel.start.row, sel.end.col === 0 && sel.end.row > sel.start.row ? sel.end.row - 1 : sel.end.row];
}

const isWord = (ch: string | undefined) => !!ch && /\w/.test(ch);
/** Where Ctrl+← lands: the start of the previous word. */
function wordLeft(line: string, col: number): number {
  let i = col;
  while (i > 0 && !isWord(line[i - 1])) i--;
  while (i > 0 && isWord(line[i - 1])) i--;
  return i;
}
/** Where Ctrl+→ lands: the end of the next word. */
function wordRight(line: string, col: number): number {
  let i = col;
  while (i < line.length && !isWord(line[i])) i++;
  while (i < line.length && isWord(line[i])) i++;
  return i;
}

const LINE_COMMENTS: Record<string, string> = {
  ".ts": "//", ".tsx": "//", ".mts": "//", ".cts": "//", ".js": "//", ".jsx": "//", ".mjs": "//", ".cjs": "//",
  ".go": "//", ".rs": "//", ".java": "//", ".c": "//", ".h": "//", ".cpp": "//", ".cc": "//", ".hpp": "//",
  ".cs": "//", ".swift": "//", ".kt": "//", ".kts": "//", ".scala": "//", ".dart": "//", ".php": "//", ".jsonc": "//",
  ".py": "#", ".pyi": "#", ".rb": "#", ".sh": "#", ".bash": "#", ".zsh": "#", ".ps1": "#", ".yml": "#", ".yaml": "#",
  ".toml": "#", ".r": "#", ".pl": "#", ".ex": "#", ".exs": "#", ".dockerfile": "#", ".sql": "--", ".lua": "--", ".hs": "--",
};
const commentFor = (file: string) => LINE_COMMENTS[path.extname(file).toLowerCase()] ?? (path.basename(file).toLowerCase() === "dockerfile" ? "#" : null);

type Prompt = { kind: "find" | "line"; text: string };

/** A text editor: arrows and the mouse to move, Shift to select, Ctrl+C/X/V clipboard, Ctrl+S save, Ctrl+Z undo, Esc leave. */
export const Editor = memo(function Editor({ width, height, focused, filePath, initial, baseline, startLine, startCol, problems, autoSave, syntaxVersion, wheel, scrollTo, mouse, onSave, onExit, onState, onHover, onDefinition, tabs, guide, onGuideDone }: Props) {
  const eol = useMemo(() => (baseline.includes("\r\n") ? "\r\n" : "\n"), [baseline]);
  const indentUnit = useMemo(() => (/^\t/m.test(initial) ? "\t" : "  "), [initial]);
  const comment = useMemo(() => commentFor(filePath), [filePath]);
  const [buf, setBuf] = useState<Buffer>(() => {
    const lines = initial.replace(/\r\n/g, "\n").split("\n");
    if (guide) {
      // A fresh line for the guided code, indented like its first line.
      const row = Math.max(0, Math.min(lines.length, guide.row));
      const indent = guide.code.match(/^[ \t]*/)![0];
      lines.splice(row, 0, indent);
      return { lines, row, col: indent.length, anchor: null };
    }
    const row = Math.max(0, Math.min(lines.length - 1, (startLine ?? 1) - 1));
    const col = startCol ? Math.min(lines[row]!.length, startCol - 1) : lines[row]!.match(/^\s*/)![0].length;
    return { lines, row, col, anchor: null };
  });
  const [hover, setHover] = useState<string | null>(null);
  const [saved, setSaved] = useState(() => baseline.replace(/\r\n/g, "\n"));
  const [confirmExit, setConfirmExit] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const undo = useRef<Buffer[]>([]);
  const redo = useRef<Buffer[]>([]);
  // Consecutive typing within a word is one undo step, like VS Code.
  const lastEdit = useRef<{ kind: string; time: number }>({ kind: "", time: 0 });
  // The first line and column shown. Moving the cursor scrolls to keep it in view; the wheel and the
  // scrollbar move the view on their own and leave the cursor where it is.
  const view = useRef({ top: 0, left: 0 });
  const reveal = useRef(true);
  const [, rerender] = useState(0);
  // Where a mouse drag started, to select from there.
  const dragFrom = useRef<Pos | null>(null);

  const dirty = useMemo(() => buf.lines.join("\n") !== saved, [buf.lines, saved]);
  const hasSelection = !!selection(buf);
  useEffect(() => onState({ line: buf.row + 1, col: buf.col + 1, dirty, lines: buf.lines, selection: hasSelection }), [buf, dirty]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const edit = (fn: (b: Buffer) => Buffer, kind = "other") => {
    reveal.current = true;
    setBuf((b) => {
      const now = Date.now();
      const grouped = kind !== "other" && kind === lastEdit.current.kind && now - lastEdit.current.time < 1000 && !b.anchor;
      if (!grouped) {
        undo.current.push(b);
        if (undo.current.length > 500) undo.current.shift();
      }
      redo.current = [];
      lastEdit.current = { kind, time: now };
      return fn(b);
    });
  };

  const step = (from: { current: Buffer[] }, to: { current: Buffer[] }) => {
    reveal.current = true;
    setBuf((b) => {
      const target = from.current.pop();
      if (!target) return b;
      to.current.push(b);
      lastEdit.current = { kind: "", time: 0 };
      return target;
    });
  };

  /** Inserts text at the cursor, replacing the selection. */
  const insertInto = (b0: Buffer, text: string): Buffer => {
    const b = deleteSelection(b0);
    const pieces = text.replace(/\r\n?/g, "\n").split("\n");
    const line = b.lines[b.row]!;
    const head = line.slice(0, b.col);
    const tail = line.slice(b.col);
    const lines = [...b.lines];
    if (pieces.length === 1) {
      lines[b.row] = head + text + tail;
      return { lines, row: b.row, col: b.col + text.length, anchor: null };
    }
    const last = pieces[pieces.length - 1]!;
    lines.splice(b.row, 1, head + pieces[0], ...pieces.slice(1, -1), last + tail);
    return { lines, row: b.row + pieces.length - 1, col: last.length, anchor: null };
  };
  const insert = (text: string, kind = "other") => edit((b) => insertInto(b, text), kind);

  /** Moves the cursor; with `select`, extends the selection instead of clearing it. */
  const move = (fn: (b: Buffer) => Partial<Pos>, select = false) => {
    reveal.current = true;
    setBuf((b) => {
      const next = { ...b, ...fn(b) };
      next.row = Math.max(0, Math.min(next.lines.length - 1, next.row));
      next.col = Math.max(0, Math.min(next.lines[next.row]!.length, next.col));
      next.anchor = select ? b.anchor ?? { row: b.row, col: b.col } : null;
      return next;
    });
  };

  /** Applies `fn` to each line a line-wise command covers, keeping the selection over the same lines. */
  const eachLine = (fn: (line: string, row: number) => string) =>
    edit((b) => {
      const [first, last] = selectedRows(b);
      const lines = [...b.lines];
      for (let r = first; r <= last; r++) lines[r] = fn(lines[r]!, r);
      const shift = (p: Pos) => ({ row: p.row, col: Math.max(0, Math.min(lines[p.row]!.length, p.col + lines[p.row]!.length - b.lines[p.row]!.length)) });
      const cursor = shift({ row: b.row, col: b.col });
      return { lines, ...cursor, anchor: b.anchor ? shift(b.anchor) : null };
    });

  const toggleComment = () => {
    if (!comment) return setFlash("No line comments for this file type");
    const [first, last] = selectedRows(buf);
    const target = buf.lines.slice(first, last + 1).filter((l) => l.trim());
    const uncomment = target.length > 0 && target.every((l) => l.trimStart().startsWith(comment));
    const indent = Math.min(...target.map((l) => l.match(/^\s*/)![0].length), Infinity);
    const marker = new RegExp(`^(\\s*)${comment.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")} ?`);
    eachLine((line) => {
      if (!line.trim()) return line;
      if (uncomment) return line.replace(marker, "$1");
      return `${line.slice(0, indent)}${comment} ${line.slice(indent)}`;
    });
  };

  const moveLines = (dir: -1 | 1) =>
    edit((b) => {
      const [first, last] = selectedRows(b);
      if ((dir < 0 && first === 0) || (dir > 0 && last === b.lines.length - 1)) return b;
      const lines = [...b.lines];
      const block = lines.splice(first, last - first + 1);
      lines.splice(first + dir, 0, ...block);
      return { lines, row: b.row + dir, col: b.col, anchor: b.anchor ? { row: b.anchor.row + dir, col: b.anchor.col } : null };
    });

  const duplicate = () =>
    edit((b) => {
      const [first, last] = selectedRows(b);
      const lines = [...b.lines];
      const block = lines.slice(first, last + 1);
      lines.splice(last + 1, 0, ...block);
      const n = block.length;
      return { lines, row: b.row + n, col: b.col, anchor: b.anchor ? { row: b.anchor.row + n, col: b.anchor.col } : null };
    });

  const copy = async (cut: boolean) => {
    // Nothing selected: copy (or cut) the whole line, like VS Code.
    const text = hasSelection ? selectedText(buf) : `${buf.lines[buf.row]}\n`;
    const ok = await copyToClipboard(text);
    setFlash(ok ? (cut ? "Cut ✓" : "Copied ✓") : "Couldn't reach the clipboard");
    if (!cut) return;
    edit((b) => {
      if (selection(b)) return deleteSelection(b);
      const lines = [...b.lines];
      lines.splice(b.row, 1);
      if (!lines.length) lines.push("");
      const row = Math.min(b.row, lines.length - 1);
      return { lines, row, col: Math.min(b.col, lines[row]!.length), anchor: null };
    });
  };

  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return setFlash("Couldn't read the clipboard: paste with your terminal (Ctrl+Shift+V / Cmd+V)");
    if (text) insert(text);
  };

  /** Finds `query` after (or, going back, before) the cursor, wrapping around, and selects it. */
  const find = (query: string, back = false, from: Buffer = buf) => {
    if (!query) return;
    const q = query.toLowerCase();
    const n = from.lines.length;
    const sel = selection(from);
    const origin = back ? sel?.start ?? from : sel ? sel.end : from;
    for (let i = 0; i <= n; i++) {
      const r = back ? (origin.row - i + n) % n : (origin.row + i) % n;
      const line = from.lines[r]!.toLowerCase();
      let at = -1;
      if (back) at = i === 0 ? line.lastIndexOf(q, Math.max(0, origin.col - 1)) : line.lastIndexOf(q);
      else at = line.indexOf(q, i === 0 ? origin.col : 0);
      if (i === 0 && back && at >= origin.col) at = -1;
      if (at >= 0) {
        reveal.current = true;
        setBuf((b) => ({ ...b, row: r, col: at + q.length, anchor: { row: r, col: at } }));
        return;
      }
    }
    setFlash(`No "${query}" in this file`);
  };

  const save = (auto = false) => {
    const text = buf.lines.join("\n");
    onSave(text.replace(/\n/g, eol));
    setSaved(text);
    setFlash(auto ? "Auto-saved ✓" : "Saved ✓");
  };

  // Auto-save: a second after you stop typing, or when you leave the editor.
  useEffect(() => {
    if (autoSave !== "delay" || !dirty) return;
    const timer = setTimeout(() => save(true), 1000);
    return () => clearTimeout(timer);
  }, [buf.lines, dirty, autoSave]);
  useEffect(() => {
    if (autoSave !== "off" && !focused && dirty) save(true);
  }, [focused]);

  const position = () => ({ text: buf.lines.join("\n"), line: buf.row + 1, col: buf.col + 1 });

  const rows = Math.max(1, height - 4);
  const gutter = String(buf.lines.length).length + 2;
  const textWidth = Math.max(10, width - 3 - gutter);
  const maxTop = Math.max(0, buf.lines.length - rows);

  // Wheel and scrollbar: move the view, not the cursor.
  useEffect(() => {
    if (!wheel) return;
    reveal.current = false;
    view.current.top = Math.max(0, Math.min(maxTop, view.current.top + wheel.lines));
    view.current.left = Math.max(0, view.current.left + wheel.columns * 2);
    rerender((n) => n + 1);
  }, [wheel?.nonce]);
  useEffect(() => {
    if (!scrollTo) return;
    reveal.current = false;
    view.current.top = topFor(scrollTo.fraction, buf.lines.length, rows);
    rerender((n) => n + 1);
  }, [scrollTo?.nonce]);

  // Click to put the cursor there; double-click to select a word; drag to select.
  const lastMouse = useRef(mouse?.[mouse.length - 1]?.seq ?? 0); // events from before the editor opened are done
  useEffect(() => {
    for (const event of mouse ?? []) {
      if (event.seq <= lastMouse.current) continue;
      lastMouse.current = event.seq;
      handleMouse(event);
    }
  }, [mouse]);
  const handleMouse = (mouse: EditorMouse) => {
    if (mouse.kind === "release") {
      dragFrom.current = null;
      return;
    }
    const v = view.current;
    const row = Math.max(0, Math.min(buf.lines.length - 1, v.top + mouse.y));
    const col = bufferCol(buf.lines[row]!, Math.max(0, mouse.x - gutter) + v.left);
    setHover(null);
    setPrompt((p) => (p?.kind === "line" ? null : p));
    if (mouse.kind === "define") {
      dragFrom.current = null;
      setBuf((b) => ({ ...b, row, col, anchor: null }));
      return onDefinition(buf.lines.join("\n"), row + 1, col + 1);
    }
    setBuf((b) => {
      if (mouse.kind === "press") {
        dragFrom.current = { row, col };
        return { ...b, row, col, anchor: null };
      }
      if (mouse.kind === "double") {
        // Double-click selects the word under the pointer.
        const line = b.lines[row]!;
        const at = isWord(line[col]) ? col : isWord(line[col - 1]) ? col - 1 : -1;
        dragFrom.current = null;
        if (at < 0) return { ...b, row, col, anchor: null };
        return { ...b, row, col: wordRight(line, at), anchor: { row, col: wordLeft(line, at + 1) } };
      }
      return { ...b, row, col, anchor: dragFrom.current ?? b.anchor ?? { row: b.row, col: b.col } };
    });
    // Dragging past the top or bottom edge scrolls.
    if (mouse.kind === "drag" && (mouse.y < 0 || mouse.y >= rows)) reveal.current = true;
  };

  usePaste((text) => {
    if (prompt) return setPrompt({ ...prompt, text: prompt.text + text.replace(/\s+/g, " ") });
    insert(text);
  }, { isActive: focused });

  useInput((input, key) => {
    if (confirmExit) {
      if (key.escape) onExit();
      else if (key.ctrl && input === "s") {
        save();
        onExit();
      } else setConfirmExit(false);
      return;
    }
    if (hover) setHover(null);

    // Find (Ctrl+F) and go to line (Ctrl+L) take the keyboard while open.
    if (prompt) {
      if (key.escape) return setPrompt(null);
      if (key.return) {
        if (prompt.kind === "find") return find(prompt.text, key.shift);
        const n = Number(prompt.text);
        if (n > 0) move(() => ({ row: n - 1, col: buf.lines[n - 1]?.match(/^\s*/)?.[0].length ?? 0 }));
        return setPrompt(null);
      }
      if (prompt.kind === "find" && (key.downArrow || key.upArrow)) return find(prompt.text, key.upArrow);
      if (key.backspace || key.delete) return setPrompt({ ...prompt, text: prompt.text.slice(0, -1) });
      if (key.ctrl && input === "f") return find(prompt.text);
      if (input && !key.ctrl && !key.meta && (prompt.kind === "find" || /^\d+$/.test(input))) {
        const text = prompt.text + input;
        setPrompt({ ...prompt, text });
        // Find as you type, from where the search started.
        if (prompt.kind === "find") find(text, false, { ...buf, col: selection(buf)?.start.col ?? buf.col, anchor: null });
      }
      return;
    }

    if (key.ctrl && input === "c") {
      // With a selection Ctrl+C copies; otherwise the app handles it (press twice to quit).
      if (hasSelection) void copy(false);
      return;
    }
    if (key.ctrl && input === "x") return void copy(true);
    if (key.ctrl && input === "v") return void paste();
    if (key.ctrl && input === "a") {
      reveal.current = true;
      const last = buf.lines.length - 1;
      return setBuf((b) => ({ ...b, row: last, col: b.lines[last]!.length, anchor: { row: 0, col: 0 } }));
    }
    if (key.ctrl && input === "s") return save();
    if (key.ctrl && input === "z") return step(undo, redo);
    if (key.ctrl && input === "y") return step(redo, undo);
    if (key.ctrl && input === "f") {
      const word = selectedText(buf);
      return setPrompt({ kind: "find", text: word.includes("\n") ? "" : word });
    }
    if (key.ctrl && input === "l") return setPrompt({ kind: "line", text: "" });
    if (key.ctrl && input === "d") return duplicate();
    // Ctrl+/ arrives as Ctrl+_ (0x1f) in most terminals.
    if ((key.ctrl && (input === "/" || input === "_")) || input === "\x1f") return toggleComment();
    if (key.ctrl && input === "k") {
      const { text, line, col } = position();
      setFlash("…");
      void onHover(text, line, col).then((info) => {
        setFlash(null);
        setHover(info ?? "No info here (needs a language server for this file type).");
      });
      return;
    }
    if (key.ctrl && input === "g") {
      const { text, line, col } = position();
      return onDefinition(text, line, col);
    }
    if (key.ctrl && input === "w") {
      return edit((b) => {
        if (selection(b)) return deleteSelection(b);
        const line = b.lines[b.row]!;
        const to = wordLeft(line, b.col);
        const lines = [...b.lines];
        lines[b.row] = line.slice(0, to) + line.slice(b.col);
        return { ...b, lines, col: to, anchor: null };
      }, "delete");
    }
    if (key.escape) {
      if (hasSelection) return setBuf((b) => ({ ...b, anchor: null }));
      if (dirty && autoSave !== "off") {
        save(true);
        return onExit();
      }
      return dirty ? setConfirmExit(true) : onExit();
    }

    const select = key.shift;
    const word = key.ctrl || key.meta;
    if (key.meta && !key.shift && (key.upArrow || key.downArrow)) return moveLines(key.upArrow ? -1 : 1);
    if (key.upArrow) return move((b) => ({ row: b.row - 1, col: bufferCol(b.lines[b.row - 1] ?? "", screenCol(b.lines[b.row]!, b.col)) }), select);
    if (key.downArrow) return move((b) => ({ row: b.row + 1, col: bufferCol(b.lines[b.row + 1] ?? "", screenCol(b.lines[b.row]!, b.col)) }), select);
    if (key.leftArrow) {
      const sel = selection(buf);
      if (sel && !select && !word) return move(() => sel.start);
      return move((b) => (word ? { col: wordLeft(b.lines[b.row]!, b.col) }
        : b.col > 0 ? { col: b.col - 1 } : b.row > 0 ? { row: b.row - 1, col: b.lines[b.row - 1]!.length } : {}), select);
    }
    if (key.rightArrow) {
      const sel = selection(buf);
      if (sel && !select && !word) return move(() => sel.end);
      return move((b) => (word ? { col: wordRight(b.lines[b.row]!, b.col) }
        : b.col < b.lines[b.row]!.length ? { col: b.col + 1 } : b.row < b.lines.length - 1 ? { row: b.row + 1, col: 0 } : {}), select);
    }
    if (key.home) {
      if (key.ctrl) return move(() => ({ row: 0, col: 0 }), select);
      return move((b) => {
        const indent = b.lines[b.row]!.match(/^\s*/)![0].length;
        return { col: b.col === indent ? 0 : indent };
      }, select);
    }
    if (key.end) {
      if (key.ctrl) return move((b) => ({ row: b.lines.length - 1, col: b.lines[b.lines.length - 1]!.length }), select);
      return move((b) => ({ col: b.lines[b.row]!.length }), select);
    }
    if (key.pageUp) return move((b) => ({ row: b.row - rows }), select);
    if (key.pageDown) return move((b) => ({ row: b.row + rows }), select);

    if (key.return) {
      // Keep the indent; one level more after an opening bracket (or a colon, in Python).
      const head = buf.lines[buf.row]!.slice(0, buf.col);
      const indent = head.match(/^\s*/)![0];
      const opens = /[{[(]\s*$/.test(head) || (/\.pyi?$/.test(filePath) && /:\s*$/.test(head));
      const closes = /^\s*[}\])]/.test(buf.lines[buf.row]!.slice(buf.col));
      if (opens && closes) {
        // Between brackets: open an indented line and put the closing bracket below it.
        insert(`\n${indent}${indentUnit}\n${indent}`);
        return move((b) => ({ row: b.row - 1, col: indent.length + indentUnit.length }));
      }
      return insert(`\n${indent}${opens ? indentUnit : ""}`);
    }
    if (key.tab && !key.shift && !hasSelection && guide && ghost) {
      // Guided: Tab types the rest of the line for you (and the next line's indentation).
      const end = ghost.indexOf("\n");
      const chunk = end < 0 ? ghost : ghost.slice(0, end + 1) + ghost.slice(end + 1).match(/^[ \t]*/)![0];
      return insert(chunk);
    }
    if (key.tab) {
      // With a selection, or Shift+Tab: indent or outdent whole lines.
      if (key.shift) return eachLine((line) => line.replace(new RegExp(`^(\\t| {1,${indentUnit === "\t" ? 2 : indentUnit.length}})`), ""));
      if (hasSelection) return eachLine((line) => (line ? indentUnit + line : line));
      return insert(indentUnit);
    }
    if (key.backspace) {
      return edit((b) => {
        if (selection(b)) return deleteSelection(b);
        const lines = [...b.lines];
        const line = lines[b.row]!;
        if (b.col > 0) {
          const to = word ? wordLeft(line, b.col) : b.col - 1;
          lines[b.row] = line.slice(0, to) + line.slice(b.col);
          return { lines, row: b.row, col: to, anchor: null };
        }
        if (b.row === 0) return b;
        const prev = lines[b.row - 1]!;
        lines.splice(b.row - 1, 2, prev + line);
        return { lines, row: b.row - 1, col: prev.length, anchor: null };
      }, "delete");
    }
    if (key.delete) {
      return edit((b) => {
        if (selection(b)) return deleteSelection(b);
        const lines = [...b.lines];
        const line = lines[b.row]!;
        if (b.col < line.length) lines[b.row] = line.slice(0, b.col) + line.slice(word ? wordRight(line, b.col) : b.col + 1);
        else if (b.row < lines.length - 1) lines.splice(b.row, 2, line + lines[b.row + 1]);
        return { ...b, lines, anchor: null };
      });
    }
    // Letters/digits group into one undo step per word; spaces and punctuation start a new one.
    if (input && !key.ctrl && !key.meta) insert(input, /^\w+$/.test(input) ? "type" : "other");
  }, { isActive: focused });

  // Keep the cursor on screen after it moves.
  const v = view.current;
  const cursorX = screenCol(buf.lines[buf.row]!, buf.col);
  if (reveal.current) {
    if (buf.row < v.top) v.top = buf.row;
    if (buf.row >= v.top + rows) v.top = buf.row - rows + 1;
    if (cursorX < v.left) v.left = Math.max(0, cursorX - 8);
    if (cursorX >= v.left + textWidth) v.left = cursorX - textWidth + 8;
  }
  v.top = Math.max(0, Math.min(v.top, maxTop));

  const visible = buf.lines.slice(v.top, v.top + rows);
  const colored = useMemo(
    // Scrolled sideways: every line shifts by the same amount, colors and all.
    () => {
      const lines = highlightLines(filePath, visible.join("\n"));
      return v.left === 0 ? lines : lines.map((l) => sliceAnsi(l, v.left, textWidth));
    },
    [filePath, visible.join("\n"), v.left, textWidth, syntaxVersion],
  );

  const { icon, color } = fileIcon(filePath);
  const byLine = useMemo(() => {
    const map = new Map<number, Diagnostic[]>();
    for (const d of problems) map.set(d.line, [...(map.get(d.line) ?? []), d]);
    return map;
  }, [problems]);
  const sel = selection(buf);
  // Guided typing: how much of the step's code is typed (from its line's start to the cursor).
  const guideRow = guide ? Math.max(0, Math.min(buf.lines.length - 1, guide.row)) : -1;
  const typed = guide && (buf.row > guideRow || (buf.row === guideRow)) ? [...buf.lines.slice(guideRow, buf.row), buf.lines[buf.row]!.slice(0, buf.col)].join("\n") : null;
  const progress = guide && typed !== null ? guideProgress(typed, guide.code) : -1;
  const ghost = guide && progress >= 0 ? guide.code.slice(progress) : "";
  const guideDone = useRef(false);
  useEffect(() => {
    if (guide && progress === guide.code.length && !guideDone.current) {
      guideDone.current = true;
      onGuideDone?.();
    }
  }, [progress]);
  const cursorProblem = byLine.get(buf.row + 1)?.[0];
  const selectedCount = sel ? selectedText(buf).length : 0;
  const guideStatus = !guide ? null
    : progress < 0 ? "Not quite: that doesn't match the step's code. Backspace and try again (the dim text shows what goes here)."
      : ghost ? `Type the dim text${ghost.includes("\n") ? ` (${ghost.split("\n").length} lines to go)` : ""} · Tab fills in the rest of the line · Esc stop`
        : "✓ Step done";
  const status = guideStatus && !confirmExit && !prompt ? guideStatus : confirmExit
    ? "Unsaved changes! Ctrl+S save & close · Esc discard · any key keep editing"
    : prompt
      ? prompt.kind === "find" ? `Find: ${prompt.text}▏  Enter/↓ next · Shift+Enter/↑ previous · Esc close` : `Go to line: ${prompt.text}▏  Enter go · Esc cancel`
      : flash ?? (cursorProblem
        ? `${SEVERITY_STYLE[cursorProblem.severity].icon} ${cursorProblem.message} (${cursorProblem.source})`
        : `Ln ${buf.row + 1}, Col ${buf.col + 1}${sel ? `  (${selectedCount} selected · Ctrl+C copy · Ctrl+X cut)` : ""}${dirty ? "  ● modified" : ""}   Ctrl+F find · Ctrl+/ comment · Esc done`);
  const statusColor = guideStatus && !confirmExit && !prompt ? (progress < 0 ? C.red : C.accent2) : confirmExit ? C.red : prompt ? C.accent : flash ? C.green : cursorProblem ? SEVERITY_STYLE[cursorProblem.severity].color : C.dim;
  const hoverLines = hover ? hover.split("\n").filter((l) => l.trim()).slice(0, 6) : [];
  const cursorVisible = buf.row >= v.top && buf.row < v.top + rows;

  return (
    <Pane title={<>{tabs ?? <> <Text color={color}>{icon}</Text> {filePath}{dirty ? <Text color={C.yellow}> ●</Text> : ""}</>}  <Text backgroundColor={C.green} color="black"> ✎ EDITING </Text>{!cursorVisible ? <Text color={C.dim}>  cursor on line {buf.row + 1} · ↑↓ to go back</Text> : null}</>} width={width} height={height} focused={focused} accent={C.green}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={width - 3} flexShrink={0}>
          {visible.map((line, i) => {
            const n = v.top + i;
            const isCursorLine = n === buf.row;
            const problem = byLine.get(n + 1)?.[0];
            const mark = problem ? SEVERITY_STYLE[problem.severity] : null;
            const num = (
              <Text color={mark?.color ?? (isCursorLine ? C.green : C.dim)}>
                {String(n + 1).padStart(gutter - 2)}{mark ? ` ${mark.icon}` : isCursorLine ? " ▸" : "  "}
              </Text>
            );
            const inSelection = sel && n >= sel.start.row && n <= sel.end.row;
            if (!isCursorLine && !inSelection) {
              return <Text key={n} wrap="truncate-end">{num}{colored[i] || " "}</Text>;
            }
            // Lines with the cursor or a selection show plain text, so both can be drawn exactly.
            const shown = expand(line).slice(v.left, v.left + textWidth);
            const from = inSelection ? Math.max(0, (n === sel.start.row ? screenCol(line, sel.start.col) : 0) - v.left) : 0;
            const to = inSelection ? Math.max(0, (n === sel.end.row ? screenCol(line, sel.end.col) : expand(line).length + 1) - v.left) : 0;
            const at = isCursorLine ? cursorX - v.left : -1;
            const cells: { text: string; selected: boolean; cursor: boolean }[] = [];
            for (let x = 0; x < Math.max(shown.length, at + 1, Math.min(to, textWidth)); x++) {
              const ch = shown[x] ?? " ";
              const cell = { text: ch, selected: x >= from && x < to, cursor: x === at && focused };
              const last = cells[cells.length - 1];
              if (last && !cell.cursor && !last.cursor && last.selected === cell.selected) last.text += ch;
              else cells.push(cell);
            }
            // The code still to type, dim, from the cursor to the end of its line (only past the line's text).
            const ghostLine = isCursorLine && ghost && buf.col >= line.length ? ghost.split("\n")[0]! : "";
            const ghostMore = isCursorLine && ghost && buf.col >= line.length ? ghost.split("\n").length - 1 : 0;
            return (
              <Text key={n} wrap="truncate-end">
                {num}
                {cells.map((c, j) => c.cursor
                  ? <Text key={j} inverse color={C.green}>{ghostLine ? ghostLine[0] : c.text}</Text>
                  : <Text key={j} color={C.text} {...(c.selected ? { backgroundColor: "#364a82" } : {})}>{c.text}</Text>)}
                {ghostLine.length > 1 ? <Text color={C.dim} italic>{expand(ghostLine.slice(1))}</Text> : null}
                {ghostMore ? <Text color={C.accent2}>{ghostLine ? "  " : ""}⏎{ghostMore > 1 ? ` +${ghostMore - 1} line${ghostMore > 2 ? "s" : ""}` : ""}</Text> : null}
              </Text>
            );
          })}
        </Box>
        <Scrollbar total={buf.lines.length} top={v.top} rows={rows} focused={focused} />
      </Box>
      {hoverLines.length > 0 && (
        <Box position="absolute" top={Math.max(1, rows - hoverLines.length - 1)} left={gutter + 1} flexDirection="column" borderStyle="round" borderColor={C.accent2} width={Math.min(width - gutter - 3, 2 + Math.max(...hoverLines.map((l) => l.length)))}>
          {hoverLines.map((l, i) => <Text key={i} color={C.text} wrap="truncate-end">{l.padEnd(width)}</Text>)}
        </Box>
      )}
      <Text wrap="truncate-end" color={statusColor}>
        {` ${status}`}
      </Text>
    </Pane>
  );
});
