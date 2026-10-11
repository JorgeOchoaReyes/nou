import { useEffect, useMemo, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import type { ApprovalRequest, ChatEntry } from "../agent/index.js";
import { wrap } from "./text.js";
import { ChatInput, inputHeight } from "./ChatInput.js";
import { C, SPINNER } from "./theme.js";
import { Pane } from "./Pane.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  entries: ChatEntry[];
  streaming: string;
  busy: string | null;
  approval: ApprovalRequest | null;
  /** Problems a proposed edit would add, shown with the approval prompt. */
  approvalNote?: string | null;
  /** Short description of the editor context sent with the next message, e.g. "src/a.ts:10-40". */
  contextChip: string | null;
  onSubmit(text: string): void;
};

type Line = { text: string; color?: string; bold?: boolean; dim?: boolean; bar?: string };

export const COMMANDS = ["/model", "/models", "/settings", "/undo", "/rewind", "/history", "/problems", "/version", "/clear", "/help"];

export function Chat({ width, height, focused, entries, streaming, busy, approval, approvalNote, contextChip, onSubmit }: Props) {
  const [input, setInput] = useState("");
  const [scrollBack, setScrollBack] = useState(0);
  const { frame } = useAnimation({ interval: 80, isActive: !!busy });
  const inner = width - 2;

  const lines = useMemo(() => {
    const out: Line[] = [];
    const all = streaming ? [...entries, { kind: "assistant" as const, text: streaming }] : entries;
    for (const entry of all) {
      if (entry.kind === "user") {
        out.push({ text: "you", color: C.cyan, bold: true, bar: C.cyan });
        for (const line of wrap(entry.text, inner - 3)) out.push({ text: line, color: C.text, bar: C.cyan });
        out.push({ text: "" });
      } else if (entry.kind === "assistant") {
        out.push({ text: "◆ nou", color: C.accent2, bold: true, bar: C.accent2 });
        for (const line of wrap(entry.text, inner - 3)) {
          const isCode = /^\s{2,}|^```|^\s*[{}();]/.test(line);
          out.push({ text: line, ...(isCode ? { color: C.yellow } : {}), bar: C.accent2 });
        }
        out.push({ text: "" });
      } else {
        const style = entry.kind === "tool"
          ? { icon: "⚙", color: C.dim }
          : entry.kind === "error" ? { icon: "✖", color: C.red } : { icon: "ℹ", color: C.accent };
        wrap(entry.text, inner - 4).forEach((line, i) =>
          out.push({ text: `${i === 0 ? ` ${style.icon}` : "  "} ${line}`, color: style.color }));
      }
    }
    return out;
  }, [entries, streaming, inner]);

  // New output snaps the view back to the bottom.
  useEffect(() => setScrollBack(0), [entries.length, streaming]);

  const footer: Line[] = [];
  if (approval?.kind === "command") {
    footer.push({ text: "⚡ Run this command?", color: C.yellow, bold: true });
    for (const line of wrap(`$ ${approval.command}`, inner - 2)) footer.push({ text: ` ${line}`, color: C.text });
    footer.push({ text: " [y] allow   [n] deny   [Esc] stop", color: C.yellow });
  } else if (approval?.kind === "tool") {
    footer.push({ text: `🔌 Plugin tool: ${approval.name}`, color: C.yellow, bold: true });
    for (const line of wrap(JSON.stringify(approval.args), inner - 2).slice(0, 4)) footer.push({ text: ` ${line}`, color: C.text });
    footer.push({ text: " [y] allow   [n] deny   [Esc] stop", color: C.yellow });
  } else if (approval?.kind === "change") {
    footer.push({ text: `✎ Review ${approval.change.path} →`, color: C.yellow, bold: true });
    if (approvalNote) {
      footer.push({ text: "⚠ This edit adds problems:", color: C.red, bold: true });
      for (const line of wrap(approvalNote, inner - 2).slice(0, 6)) footer.push({ text: ` ${line}`, color: C.red });
    }
    footer.push({ text: " [y] accept   [n] reject   [Esc] stop", color: C.yellow });
  } else if (busy) {
    footer.push({ text: `${SPINNER[frame % SPINNER.length]} ${busy}`, color: C.accent2 });
  }

  const suggestions = input.startsWith("/") && !input.includes(" ")
    ? COMMANDS.filter((c) => c.startsWith(input) && c !== input)
    : [];

  const inputRows = inputHeight(input, inner);
  const rows = Math.max(1, height - 3 - footer.length - 2 - inputRows);
  const history = useMemo(() => entries.filter((e) => e.kind === "user").map((e) => e.text), [entries]);
  const maxBack = Math.max(0, lines.length - rows);
  const back = Math.min(scrollBack, maxBack);
  const visible = lines.slice(Math.max(0, lines.length - rows - back), lines.length - back);

  useInput((_input, key) => {
    if (key.pageUp || (key.upArrow && key.shift)) setScrollBack((b) => Math.min(maxBack, b + Math.max(1, rows - 2)));
    else if (key.pageDown || (key.downArrow && key.shift)) setScrollBack((b) => Math.max(0, b - Math.max(1, rows - 2)));
  }, { isActive: focused });

  const submit = (value: string) => {
    if (!value.trim() || busy || approval) return;
    // "/se" + Enter runs /settings when only one command matches.
    const command = !COMMANDS.includes(value.trim()) && suggestions.length === 1 ? suggestions[0]! : value.trim();
    setInput("");
    onSubmit(command);
  };

  const render = (line: Line, key: string | number) => (
    <Text key={key} wrap="truncate-end">
      {line.bar ? <Text color={line.bar}>▌ </Text> : null}
      <Text bold={!!line.bold} dimColor={!!line.dim} {...(line.color ? { color: line.color } : {})}>{line.text || " "}</Text>
    </Text>
  );

  const empty = entries.length === 0 && !streaming;
  const title = <> <Text color={C.accent2}>◆</Text> Chat{back ? <Text color={C.dim}> ↑{back} more</Text> : null}</>;

  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="column" height={rows}>
        {empty ? (
          <Box flexDirection="column" paddingX={1}>
            <Text color={C.dim}>Try:</Text>
            <Text color={C.text}>  “explain this file”</Text>
            <Text color={C.text}>  “what changed since my last commit?”</Text>
            <Text color={C.text}>  “add error handling here”</Text>
            <Text> </Text>
            <Text color={C.dim}>I can see the file you have open.</Text>
          </Box>
        ) : visible.map((line, i) => render(line, i))}
      </Box>
      <Box flexDirection="column">
        {footer.map((line, i) => render(line, `f${i}`))}
      </Box>
      <Text wrap="truncate-end" color={C.dim}>
        {suggestions.length
          ? <Text color={C.accent}>{suggestions.join("  ")}  <Text color={C.dim}>{suggestions.length === 1 ? "Enter ↵" : ""}</Text></Text>
          : contextChip ? <><Text color={C.cyan}>@</Text> {contextChip}</> : " "}
      </Text>
      <Text color={focused ? C.accent : C.dim}>{"─".repeat(Math.max(0, inner))}</Text>
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={submit}
        focus={focused && !approval}
        width={inner}
        history={history}
        placeholder={busy ? "working… Esc to stop" : "Ask anything · / for commands · ↑ history"}
      />
    </Pane>
  );
}
