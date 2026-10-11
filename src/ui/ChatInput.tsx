import { useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { C } from "./theme.js";

type Segment = { start: number; end: number };

/** Word-wraps `text` into segments of at most `width` characters, honoring newlines. */
export function layout(text: string, width: number): Segment[] {
  const w = Math.max(1, width);
  const segments: Segment[] = [];
  let pos = 0;
  while (pos <= text.length) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 ? text.length : newline;
    if (lineEnd - pos <= w) {
      segments.push({ start: pos, end: lineEnd });
      if (newline === -1) break;
      pos = newline + 1;
      continue;
    }
    // Break after the last space that fits, or hard-break a long word.
    const space = text.lastIndexOf(" ", pos + w - 1);
    const end = space >= pos ? space + 1 : pos + w;
    segments.push({ start: pos, end });
    pos = end;
  }
  return segments;
}

/** The segment the cursor sits in; a cursor at a wrap boundary belongs to the next line. */
function cursorLine(segments: Segment[], cursor: number): number {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const next = segments[i + 1];
    if (cursor >= s.start && (cursor < s.end || (cursor === s.end && (!next || next.start > s.end)))) return i;
  }
  return segments.length - 1;
}

type Props = {
  value: string;
  onChange(value: string): void;
  onSubmit(value: string): void;
  focus: boolean;
  width: number;
  placeholder: string;
  /** Earlier messages, oldest first, for ↑/↓ recall. */
  history: string[];
  maxLines?: number;
};

export function ChatInput({ value, onChange, onSubmit, focus, width, placeholder, history, maxLines = 6 }: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [recall, setRecall] = useState<number | null>(null);
  const stash = useRef("");
  const textWidth = Math.max(4, width - 2);
  const pos = Math.min(cursor, value.length);
  const segments = layout(value, textWidth);
  const line = cursorLine(segments, pos);

  const set = (next: string, nextCursor: number) => {
    onChange(next);
    setCursor(Math.max(0, Math.min(next.length, nextCursor)));
  };
  const insert = (text: string) => set(value.slice(0, pos) + text + value.slice(pos), pos + text.length);

  const recallHistory = (step: -1 | 1) => {
    if (!history.length) return false;
    const current = recall ?? history.length;
    const next = current + step;
    if (next < 0 || next > history.length) return false;
    if (recall === null) stash.current = value;
    const text = next === history.length ? stash.current : history[next]!;
    setRecall(next === history.length ? null : next);
    set(text, text.length);
    return true;
  };

  usePaste((text) => insert(text.replace(/\r\n?/g, "\n")), { isActive: focus });

  useInput((input, key) => {
    if (key.tab || key.escape || key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow))) return;
    if (key.return) {
      setRecall(null);
      onSubmit(value);
      return;
    }
    if (key.backspace) return pos > 0 && set(value.slice(0, pos - 1) + value.slice(pos), pos - 1);
    if (key.delete) return pos < value.length && set(value.slice(0, pos) + value.slice(pos + 1), pos);
    if (key.leftArrow) return setCursor(key.ctrl || key.meta ? value.lastIndexOf(" ", pos - 2) + 1 : pos - 1 < 0 ? 0 : pos - 1);
    if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        const next = value.indexOf(" ", pos + 1);
        return setCursor(next === -1 ? value.length : next);
      }
      return setCursor(Math.min(value.length, pos + 1));
    }
    if (key.home || (key.ctrl && input === "a")) return setCursor(segments[line]!.start);
    if (key.end || (key.ctrl && input === "e")) return setCursor(segments[line]!.end);
    if (key.ctrl && input === "u") return set("", 0);
    if (key.upArrow || key.downArrow) {
      const target = line + (key.upArrow ? -1 : 1);
      if (target >= 0 && target < segments.length) {
        // Move between wrapped lines, keeping the column.
        const col = pos - segments[line]!.start;
        const s = segments[target]!;
        return setCursor(Math.min(s.start + col, s.end));
      }
      recallHistory(key.upArrow ? -1 : 1);
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    insert(input.replace(/\r\n?/g, "\n"));
  }, { isActive: focus });

  // Show a window of lines around the cursor once the message gets long.
  const first = Math.max(0, Math.min(line - maxLines + 1, segments.length - maxLines));
  const shown = segments.slice(first, first + maxLines);
  const prompt = (i: number) => (
    <Text color={focus ? C.accent2 : C.dim} bold>{first + i === 0 ? "❯ " : first > 0 && i === 0 ? "↑ " : "  "}</Text>
  );

  if (!value) {
    return (
      <Box>
        {prompt(0)}
        {focus ? <Text inverse> </Text> : null}
        <Text color={C.dim} wrap="truncate-end">{placeholder}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {shown.map((s, i) => {
        const text = value.slice(s.start, s.end).replace(/\n/g, "");
        const isCursor = focus && first + i === line;
        if (!isCursor) {
          return <Text key={first + i}>{prompt(i)}<Text color={C.text}>{text || " "}</Text></Text>;
        }
        const at = pos - s.start;
        return (
          <Text key={first + i}>
            {prompt(i)}
            <Text color={C.text}>{text.slice(0, at)}</Text>
            <Text inverse>{text[at] ?? " "}</Text>
            <Text color={C.text}>{text.slice(at + 1)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** How many rows the input will take, so the chat can size its history above it. */
export function inputHeight(value: string, width: number, maxLines = 6): number {
  return value ? Math.min(maxLines, layout(value, Math.max(4, width - 2)).length) : 1;
}
