import { memo, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Shell } from "../terminal/index.js";
import { C } from "./theme.js";
import type { Wheel } from "./scroll.js";

type Props = {
  shell: Shell;
  /** Bumped when the shell has new output. */
  version: number;
  width: number;
  height: number;
  focused: boolean;
  wheel?: Wheel | null;
  /** Esc: back to the pane you came from (the command keeps running). */
  onLeave(): void;
  /** Alt+↑/↓: taller or shorter, by this many rows. */
  onResize(by: number): void;
};

const COLORS = { out: C.text, command: C.accent, info: C.dim, error: C.red } as const;

/**
 * The terminal panel, under the code like VS Code's: type a command and Enter runs it. While one runs,
 * what you type goes to it; Ctrl+C stops it. ↑↓ go through what you ran, Ctrl+L clears, Esc leaves.
 * Drag its top border (or Alt+↑/↓) to make it taller or shorter.
 */
export const Terminal = memo(function Terminal({ shell, version, width, height, focused, wheel, onLeave, onResize }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [back, setBack] = useState(-1);
  const [scroll, setScroll] = useState(0);
  const inner = width - 2;
  const rows = Math.max(1, height - 3); // borders and the title
  const lines = shell.view();

  // Fit long lines by wrapping them, newest at the bottom.
  const wrapped: { text: string; color: string }[] = [];
  for (const line of lines.slice(-rows * 4)) {
    const text = line.text || " ";
    for (let i = 0; i < text.length; i += inner) wrapped.push({ text: text.slice(i, i + inner), color: COLORS[line.kind] });
  }
  const promptText = shell.running ? "› " : shell.prompt();
  const shownPrompt = `${promptText}${input}`;
  const promptRows = Math.max(1, Math.ceil((shownPrompt.length + 1) / inner));
  const outRows = Math.max(0, rows - promptRows);
  const maxScroll = Math.max(0, wrapped.length - outRows);
  const at = Math.min(scroll, maxScroll);
  const shown = wrapped.slice(Math.max(0, wrapped.length - outRows - at), wrapped.length - at);

  useEffect(() => setScroll(0), [version]); // new output: back to the bottom
  useEffect(() => {
    if (wheel?.lines) setScroll((s) => Math.max(0, Math.min(maxScroll, s - wheel.lines)));
  }, [wheel?.nonce]);

  useInput((typed, key) => {
    if (key.escape) return onLeave();
    if (key.ctrl && typed === "c") {
      if (shell.running) shell.interrupt();
      else setInput("");
      return;
    }
    if (key.ctrl && typed === "l") return shell.clear();
    if (key.return) {
      if (!shell.running && input.trim()) setHistory((h) => [...h.filter((c) => c !== input.trim()), input.trim()].slice(-100));
      if (shell.running) shell.input(input);
      else shell.run(input);
      setInput("");
      setBack(-1);
      return;
    }
    if (key.meta && (key.upArrow || key.downArrow)) return onResize(key.upArrow ? 2 : -2);
    if (key.upArrow || key.downArrow) {
      if (!history.length) return;
      const next = key.upArrow ? Math.min(history.length - 1, back + 1) : back - 1;
      setBack(next);
      setInput(next < 0 ? "" : history[history.length - 1 - next]!);
      return;
    }
    if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + outRows - 1));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - outRows + 1));
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (key.ctrl && typed === "u") return setInput("");
    if (key.ctrl || key.meta || key.tab) return;
    if (typed) setInput((v) => v + typed.replace(/[\r\n]+/g, " "));
  }, { isActive: focused });

  const color = focused ? C.accent : C.dim;
  const title = ` ▸ Terminal${shell.running ? "  ● running · Ctrl+C stops" : ""}${at ? `  ↑ ${at} lines` : ""}`;
  return (
    <Box width={width} height={height} flexDirection="column" borderStyle={focused ? "round" : "single"} borderColor={color} overflow="hidden">
      <Text wrap="truncate-end"><Text color={color} bold>{title.slice(0, inner - 3).padEnd(inner - 3)}</Text><Text color={C.text} bold> × </Text></Text>
      <Box flexDirection="column" height={outRows} flexShrink={0}>
        {shown.map((l, i) => <Text key={i} color={l.color} wrap="truncate-end">{l.text}</Text>)}
      </Box>
      <Text wrap="wrap">
        <Text color={shell.running ? C.yellow : C.green}>{promptText}</Text>
        <Text color={C.text}>{input}</Text>
        {focused ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
});
