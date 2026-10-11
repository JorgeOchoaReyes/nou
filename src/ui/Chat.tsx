import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalRequest, ChatEntry } from "../agent/index.js";
import { wrap } from "./text.js";
import { Pane } from "./Pane.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  entries: ChatEntry[];
  streaming: string;
  busy: string | null;
  approval: ApprovalRequest | null;
  onSubmit(text: string): void;
};

const STYLE: Record<ChatEntry["kind"], { label: string; color: string }> = {
  user: { label: "you", color: "cyan" },
  assistant: { label: "nou", color: "green" },
  tool: { label: "  •", color: "yellow" },
  error: { label: "  !", color: "red" },
  info: { label: "  ·", color: "blue" },
};

type Line = { text: string; color?: string; bold?: boolean; dim?: boolean };

export function Chat({ width, height, focused, entries, streaming, busy, approval, onSubmit }: Props) {
  const [input, setInput] = useState("");
  const [scrollBack, setScrollBack] = useState(0);
  const inner = width - 2;

  const lines = useMemo(() => {
    const out: Line[] = [];
    const all = streaming ? [...entries, { kind: "assistant" as const, text: streaming }] : entries;
    for (const entry of all) {
      const { label, color } = STYLE[entry.kind];
      const compact = entry.kind !== "user" && entry.kind !== "assistant";
      if (!compact) out.push({ text: label, color, bold: true });
      for (const line of wrap(entry.text, inner - (compact ? 4 : 1))) {
        out.push(compact
          ? { text: `${label} ${line}`, color, dim: entry.kind === "tool" }
          : { text: ` ${line}` });
      }
      if (!compact) out.push({ text: "" });
    }
    return out;
  }, [entries, streaming, inner]);

  // New output snaps the view back to the bottom.
  useEffect(() => setScrollBack(0), [entries.length, streaming]);

  // Footer: status line + input row (+ approval prompt for commands).
  const footer: Line[] = [];
  if (approval?.kind === "command") {
    footer.push({ text: "Run this command?", color: "yellow", bold: true });
    for (const line of wrap(`$ ${approval.command}`, inner)) footer.push({ text: line, color: "yellow" });
    footer.push({ text: "[y] allow   [n] deny", color: "yellow" });
  } else if (approval?.kind === "change") {
    footer.push({ text: `Review ${approval.change.path} in the editor`, color: "yellow", bold: true });
    footer.push({ text: "[y] accept   [n] reject", color: "yellow" });
  } else if (busy) {
    footer.push({ text: `⠿ ${busy}`, color: "magenta" });
  }

  const rows = Math.max(1, height - 3 - footer.length - 2);
  const maxBack = Math.max(0, lines.length - rows);
  const back = Math.min(scrollBack, maxBack);
  const visible = lines.slice(Math.max(0, lines.length - rows - back), lines.length - back);

  useInput((_input, key) => {
    if (key.pageUp || (key.upArrow && key.shift)) setScrollBack((b) => Math.min(maxBack, b + Math.max(1, rows - 2)));
    else if (key.pageDown || (key.downArrow && key.shift)) setScrollBack((b) => Math.max(0, b - Math.max(1, rows - 2)));
  }, { isActive: focused });

  const submit = (value: string) => {
    if (!value.trim() || busy || approval) return;
    setInput("");
    onSubmit(value.trim());
  };

  const render = (line: Line, key: string | number) => (
    <Text key={key} wrap="truncate-end" bold={!!line.bold} dimColor={!!line.dim} {...(line.color ? { color: line.color } : {})}>
      {line.text || " "}
    </Text>
  );

  return (
    <Pane title={` Chat${back ? ` (↑${back})` : ""}`} width={width} height={height} focused={focused}>
      <Box flexDirection="column" height={rows}>
        {visible.map((line, i) => render(line, i))}
      </Box>
      <Box flexDirection="column">
        {footer.map((line, i) => render(line, `f${i}`))}
      </Box>
      <Text color="gray">{"─".repeat(Math.max(0, inner))}</Text>
      <Box>
        <Text color={focused ? "cyan" : "gray"}>{"› "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          focus={focused && !approval}
          placeholder={busy ? "working..." : "Ask Nou anything"}
        />
      </Box>
    </Pane>
  );
}
