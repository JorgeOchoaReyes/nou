import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import type { ApprovalRequest, ChatEntry } from "../agent/index.js";
import { renderMarkdown, wrap, type Span } from "./text.js";
import { ChatInput, inputHeight } from "./ChatInput.js";
import { C, SPINNER } from "./theme.js";
import { Pane } from "./Pane.js";
import { matchCommands, type SlashCommand } from "./commands.js";
import { Scrollbar, topFor, type ScrollTo, type Wheel } from "./scroll.js";

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
  wheel?: Wheel | null;
  /** A click or drag on the scrollbar. */
  scrollTo?: ScrollTo | null;
  /** Text to start the input with, e.g. "/" typed in another pane. */
  prefill?: { text: string; nonce: number } | null;
  /** Commands from plugins, listed in the command menu after the built-in ones. */
  extraCommands?: SlashCommand[];
  /** Whether the command menu is open, so the app leaves Tab to it. */
  onMenu?(open: boolean): void;
  onSubmit(text: string): void;
  /** Answers the approval waiting in the footer (y/n typed into an empty input). */
  onAnswer(ok: boolean): void;
};

/**
 * A display line. `lead` is its first two columns (the ▌ bar of a message, or a notice's icon), drawn
 * in a column of its own: the rest of the line is then usually plain ASCII, which Ink measures far
 * faster than text with symbols in it, and that's most of the cost of every streamed frame.
 */
type Line = { text: string; color?: string; bold?: boolean; dim?: boolean; lead?: string; leadColor?: string; spans?: Span[] };
const BAR = "▌ ";


/** Display lines for one message, wrapped to `inner` columns. */
function entryLines(entry: ChatEntry, inner: number): Line[] {
  const out: Line[] = [];
  if (entry.kind === "user") {
    out.push({ text: "you", color: C.cyan, bold: true, lead: BAR, leadColor: C.cyan });
    for (const line of wrap(entry.text, inner - 3)) out.push({ text: line, color: C.text, lead: BAR, leadColor: C.cyan });
    out.push({ text: "" });
  } else if (entry.kind === "assistant") {
    out.push({ text: "◆ nou", color: C.accent2, bold: true, lead: BAR, leadColor: C.accent2 });
    for (const line of renderMarkdown(entry.text, inner - 3)) {
      const color = line.kind === "heading" ? C.accent2 : line.kind === "quote" ? C.dim : undefined;
      out.push({ text: "", spans: line.spans, ...(color ? { color } : {}), lead: BAR, leadColor: C.accent2 });
    }
    out.push({ text: "" });
  } else {
    const style = entry.kind === "tool"
      ? { icon: "⚙", color: C.dim }
      : entry.kind === "error" ? { icon: "✖", color: C.red } : { icon: "ℹ", color: C.accent };
    wrap(entry.text, inner - 4).forEach((line, i) =>
      out.push({ text: ` ${line}`, color: style.color, lead: i === 0 ? ` ${style.icon}` : "  ", leadColor: style.color }));
  }
  return out;
}

// Finished messages never change, so each is laid out once per width; only the reply being streamed
// is redone as it grows. Without this every streamed token re-rendered the whole conversation.
const laidOut = new WeakMap<ChatEntry, { inner: number; lines: Line[] }>();
function cachedLines(entry: ChatEntry, inner: number): Line[] {
  const hit = laidOut.get(entry);
  if (hit?.inner === inner) return hit.lines;
  const lines = entryLines(entry, inner);
  laidOut.set(entry, { inner, lines });
  return lines;
}

export const Chat = memo(function Chat({ width, height, focused, entries, streaming, busy, approval, approvalNote, contextChip, wheel, scrollTo, prefill, extraCommands, onMenu, onSubmit, onAnswer }: Props) {
  const [input, setInput] = useState("");
  useEffect(() => {
    if (prefill) setInput(prefill.text);
  }, [prefill?.nonce]);
  const [scrollBack, setScrollBack] = useState(0);
  const { frame } = useAnimation({ interval: 80, isActive: !!busy });
  const inner = width - 3; // minus the borders and the scrollbar

  const history = useMemo(() => entries.flatMap((e) => cachedLines(e, inner)), [entries, inner]);
  const lines = useMemo(
    () => (streaming ? [...history, ...entryLines({ kind: "assistant", text: streaming }, inner)] : history),
    [history, streaming, inner],
  );

  // At the bottom, new output scrolls into view. Scrolled up to read, the view stays where it is
  // (counted from the bottom, so it moves up by however many lines arrived) until you scroll back down.
  const lastCount = useRef(lines.length);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const added = lines.length - lastCount.current;
    lastCount.current = lines.length;
    if (added <= 0) return;
    setScrollBack((b) => (b > 0 ? b + added : 0));
    setUnread((u) => (scrollBack > 0 ? u + added : 0));
  }, [lines.length]);
  // Sending a message always goes back to the bottom.
  useEffect(() => {
    if (entries[entries.length - 1]?.kind === "user") setScrollBack(0);
  }, [entries.length]);
  useEffect(() => {
    if (scrollBack === 0) setUnread(0);
  }, [scrollBack]);

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
    footer.push({ text: `✎ Nou wants to ${approval.change.isNew ? "create" : "edit"} ${approval.change.path}`, color: C.yellow, bold: true });
    if (approvalNote) {
      footer.push({ text: "⚠ This edit adds problems:", color: C.red, bold: true });
      for (const line of wrap(approvalNote, inner - 2).slice(0, 6)) footer.push({ text: ` ${line}`, color: C.red });
    }
    footer.push({ text: " [y] accept   [n] reject   [o] show it   [Esc] stop", color: C.yellow });
  } else if (busy) {
    footer.push({ text: `${SPINNER[frame % SPINNER.length]} ${busy}`, color: C.accent2 });
  }

  // Typing "/" opens a menu of commands with what each does; ↑↓ pick one, Tab completes, Enter runs it.
  const menuOpen = focused && !approval && input.startsWith("/") && !input.includes(" ") && !input.includes("\n");
  const matches = useMemo(() => (menuOpen ? matchCommands(input, extraCommands) : []), [menuOpen, input, extraCommands]);
  const [menuRow, setMenuRow] = useState(0);
  useEffect(() => setMenuRow(0), [input]);
  const showMenu = matches.length > 0;
  useEffect(() => onMenu?.(showMenu), [showMenu]);
  const menuRows = Math.min(matches.length, Math.max(1, Math.min(7, height - 12)));
  const menuStart = Math.max(0, Math.min(menuRow - menuRows + 1, matches.length - menuRows));
  const picked = matches[menuRow];
  /** Puts the picked command in the input, with a space when it takes arguments. */
  const complete = (c: SlashCommand) => setInput(`/${c.name}${c.args ? " " : ""}`);

  const inputRows = inputHeight(input, inner + 1);
  const rows = Math.max(1, height - 3 - footer.length - 2 - inputRows - (showMenu ? menuRows - 1 : 0));
  const sent = useMemo(() => entries.filter((e) => e.kind === "user").map((e) => e.text), [entries]);
  const maxBack = Math.max(0, lines.length - rows);
  const back = Math.min(scrollBack, maxBack);
  const firstShown = Math.max(0, lines.length - rows - back);
  const visible = lines.slice(firstShown, lines.length - back);

  useEffect(() => {
    if (wheel?.lines) setScrollBack((b) => Math.max(0, Math.min(maxBack, Math.min(b, maxBack) - wheel.lines)));
  }, [wheel?.nonce]);
  useEffect(() => {
    if (scrollTo) setScrollBack(maxBack - topFor(scrollTo.fraction, lines.length, rows));
  }, [scrollTo?.nonce]);

  // While something waits for approval, y/n into an empty input answer it; any other key starts a message.
  useInput((typed) => {
    if (/^[yYnN]$/.test(typed)) onAnswer(/[yY]/.test(typed));
    else if (typed && typed >= " ") setInput(typed); // printable, not a control key
  }, { isActive: focused && !!approval && !input });

  useInput((_input, key) => {
    if (key.pageUp || (key.upArrow && key.shift)) setScrollBack((b) => Math.min(maxBack, Math.min(b, maxBack) + Math.max(1, rows - 2)));
    else if (key.pageDown || (key.downArrow && key.shift)) setScrollBack((b) => Math.max(0, Math.min(b, maxBack) - Math.max(1, rows - 2)));
    else if (key.ctrl && key.home) setScrollBack(maxBack);
    else if (key.ctrl && key.end) setScrollBack(0);
  }, { isActive: focused });

  useInput((_input, key) => {
    if (key.upArrow && !key.shift) setMenuRow((r) => (r - 1 + matches.length) % matches.length);
    else if (key.downArrow && !key.shift) setMenuRow((r) => (r + 1) % matches.length);
    else if (key.tab && picked) complete(picked);
    else if (key.escape) setInput("");
  }, { isActive: focused && showMenu });

  const submit = (value: string) => {
    if (!value.trim() || busy || approval) return;
    let text = value.trim();
    if (showMenu && picked) {
      // Enter runs the highlighted command; one that needs an argument is completed instead, to type it.
      if (picked.args?.startsWith("<")) return complete(picked);
      text = `/${picked.name}`;
    }
    setInput("");
    onSubmit(text);
  };

  const render = (line: Line, key: string | number, withLead = true) => (
    <Text key={key} wrap="truncate-end">
      {withLead && line.lead ? <Text color={line.leadColor ?? C.dim}>{line.lead}</Text> : null}
      {line.spans?.length
        ? line.spans.map((span, i) => (
          <Text key={i} bold={!!span.bold || !!line.bold} italic={!!span.italic} dimColor={!!span.dim} {...(span.code ? { color: C.yellow } : line.color ? { color: line.color } : { color: C.text })}>{span.text}</Text>
        ))
        : <Text bold={!!line.bold} dimColor={!!line.dim} {...(line.color ? { color: line.color } : {})}>{line.text || " "}</Text>}
    </Text>
  );

  const empty = entries.length === 0 && !streaming;
  const title = (
    <>
      {" "}<Text color={C.accent2}>◆</Text> Chat
      {back
        ? unread
          ? <Text color={C.green} bold>  ↓ {unread} new lines below<Text color={C.dim}> · PgDn / wheel / Ctrl+End</Text></Text>
          : <Text color={C.yellow}>  ↑ scrolled {back} lines<Text color={C.dim}> · PgDn / wheel / Ctrl+End</Text></Text>
        : maxBack > 0 ? <Text color={C.dim}>  PgUp / wheel to scroll</Text> : null}
    </>
  );

  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={inner} flexShrink={0}>
          {empty ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={C.dim}>Try:</Text>
              <Text color={C.text}>  “explain this file”</Text>
              <Text color={C.text}>  “what changed since my last commit?”</Text>
              <Text color={C.text}>  “add error handling here”</Text>
              <Text> </Text>
              <Text color={C.dim}>I can see the file you have open.</Text>
            </Box>
          ) : (
            <Box flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text>{visible.map((line, i) => <Text key={i} color={line.leadColor ?? C.dim}>{`${line.lead ?? "  "}${i < visible.length - 1 ? "\n" : ""}`}</Text>)}</Text>
              </Box>
              <Box flexDirection="column" width={inner - 2} flexShrink={0}>
                {visible.map((line, i) => render(line, firstShown + i, false))}
              </Box>
            </Box>
          )}
        </Box>
        <Scrollbar total={lines.length} top={firstShown} rows={rows} focused={focused} />
      </Box>
      <Box flexDirection="column">
        {footer.map((line, i) => render(line, `f${i}`))}
      </Box>
      {showMenu ? (
        <Box flexDirection="column">
          {matches.slice(menuStart, menuStart + menuRows).map((c, i) => {
            const selected = menuStart + i === menuRow;
            return (
              <Text key={c.name} wrap="truncate-end" {...(selected ? { backgroundColor: C.panel } : {})}>
                <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸" : " "}</Text>
                <Text color={selected ? C.accent : C.text} bold={selected}>/{c.name}</Text>
                {c.args ? <Text color={C.dim}> {c.args}</Text> : null}
                <Text color={C.dim}>  {c.description}</Text>
              </Text>
            );
          })}
        </Box>
      ) : (
        <Text wrap="truncate-end" color={C.dim}>
          {contextChip ? <><Text color={C.cyan}>@</Text> {contextChip}</> : " "}
        </Text>
      )}
      <Text color={focused ? C.accent : C.dim}>{"─".repeat(Math.max(0, inner + 1))}</Text>
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={submit}
        focus={focused && !(approval && !input)}
        width={inner + 1}
        history={sent}
        arrowsTaken={showMenu}
        placeholder={busy ? "working… Esc to stop" : showMenu ? "↑↓ choose · Tab complete · Enter run" : "Ask anything · / for commands · ↑ history"}
      />
    </Pane>
  );
});
