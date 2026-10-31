import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import type { ApprovalRequest, ChatEntry } from "../agent/index.js";
import { statSync } from "fs";
import path from "path";
import { closeOpenMarkdown, linkAt, linkFileRefs, linkUrls, renderMarkdown, wrap, type FileRef, type Span } from "./text.js";
import { ChatInput, inputHeight } from "./ChatInput.js";
import { copyToClipboard } from "./clipboard.js";
import { C, SPINNER, ANIMATION_MS } from "./theme.js";
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
  /** `now`: send right away, interrupting Nou if it's working; otherwise a message sent while it works waits its turn. */
  onSubmit(text: string, now?: boolean): void;
  /** Messages waiting to be sent when Nou finishes. */
  queued?: string[];
  /** Answers the approval waiting in the footer (y/n typed into an empty input). */
  onAnswer(ok: boolean): void;
  /** Pressing, dragging and letting go over the messages: selects text, copied when you let go. */
  select?: ChatSelect | null;
  /** A click in the conversation: `row` from the top of the messages, `col` from where their text starts. */
  click?: { row: number; col: number; nonce: number } | null;
  /** A file reference in a message was clicked. */
  onOpenRef?(ref: FileRef): void;
};

/**
 * A display line. `lead` is its first two columns (the ▌ bar of a message, or a notice's icon), drawn
 * in a column of its own: the rest of the line is then usually plain ASCII, which Ink measures far
 * faster than text with symbols in it, and that's most of the cost of every streamed frame.
 */
type Line = {
  text: string; color?: string; bold?: boolean; dim?: boolean; lead?: string; leadColor?: string; spans?: Span[];
  /** The header of a collapsed run of steps: clicking it opens or closes the run. */
  toggle?: ChatEntry;
};

/**
 * What the agent did between replies (files read, commands run...) folds into one line, like Claude's
 * "▸ 5 steps": click it (or Ctrl+O for all of them) to see each step. `open` holds the runs shown open.
 */
function stepLines(steps: ChatEntry[], open: boolean, live: boolean, inner: number): Line[] {
  const last = steps[steps.length - 1]!.text.replace(/\s+/g, " ");
  const summary = `${open ? "▾" : "▸"} ${steps.length} steps${open ? "" : ` · ${live ? "now: " : "last: "}${last}`}`;
  const head: Line = { text: ` ${summary.length > inner - 4 ? `${summary.slice(0, inner - 5)}…` : summary}`, color: open ? C.accent2 : C.dim, lead: " ⚙", leadColor: C.dim, toggle: steps[0]! };
  return open ? [head, ...steps.flatMap((e) => cachedLines(e, inner).map((l) => (l.lead === " ⚙" ? { ...l, lead: "  " } : l)))] : [head];
}
const BAR = "▌ ";

// Whether a path in a message is a file in the project, remembered so each one is checked once.
const knownFiles = new Map<string, boolean>();
function isProjectFile(file: string): boolean {
  let known = knownFiles.get(file);
  if (known === undefined) {
    const full = path.resolve(file);
    const rel = path.relative(process.cwd(), full);
    try {
      known = !rel.startsWith("..") && !path.isAbsolute(rel) && statSync(full).isFile();
    } catch {
      known = false;
    }
    if (knownFiles.size > 5000) knownFiles.clear();
    // Only files that exist are remembered: one Nou is about to create becomes a link once it's there.
    if (known) knownFiles.set(file, known);
  }
  return known;
}


/** Display lines for one message, wrapped to `inner` columns. */
function entryLines(entry: ChatEntry, inner: number, links = true): Line[] {
  const out: Line[] = [];
  if (entry.kind === "user") {
    out.push({ text: "you", color: C.cyan, bold: true, lead: BAR, leadColor: C.cyan });
    for (const line of wrap(entry.text, inner - 3)) out.push({ text: line, color: C.text, lead: BAR, leadColor: C.cyan });
    out.push({ text: "" });
  } else if (entry.kind === "assistant") {
    out.push({ text: "◆ nou", color: C.accent2, bold: true, lead: BAR, leadColor: C.accent2 });
    for (const line of renderMarkdown(entry.text, inner - 3, links ? isProjectFile : undefined)) {
      const color = line.kind === "heading" ? C.accent2 : line.kind === "quote" ? C.dim : undefined;
      out.push({ text: "", spans: line.spans, ...(color ? { color } : {}), lead: BAR, leadColor: C.accent2 });
    }
    out.push({ text: "" });
  } else {
    const style = entry.kind === "tool"
      ? { icon: "⚙", color: C.dim }
      : entry.kind === "error" ? { icon: "✖", color: C.red } : { icon: "ℹ", color: C.accent };
    wrap(entry.text, inner - 4).forEach((line, i) => {
      const spans = links && entry.kind !== "user" ? linkFileRefs(linkUrls([{ text: ` ${line}` }]), isProjectFile) : [];
      out.push({ text: ` ${line}`, color: style.color, lead: i === 0 ? ` ${style.icon}` : "  ", leadColor: style.color, ...(spans.some((sp) => sp.link) ? { spans } : {}) });
    });
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

export type ChatSelect = { row: number; col: number; kind: "press" | "drag" | "release"; nonce: number };
type Point = { line: number; col: number };
const lineText = (line: Line) => (line.spans ? line.spans.map((s) => s.text).join("") : line.text ?? "");

export const Chat = memo(function Chat({ width, height, focused, entries, streaming, busy, approval, approvalNote, contextChip, wheel, scrollTo, prefill, extraCommands, onMenu, onSubmit, onAnswer, click, onOpenRef, select, queued = [] }: Props) {
  const [input, setInputText] = useState("");
  const [menuRow, setMenuRow] = useState(0);
  /** A new input also puts the command menu back on its first row, in the same render. */
  const setInput = (text: string) => {
    setInputText(text);
    setMenuRow(0);
  };
  useEffect(() => {
    if (prefill) setInput(prefill.text);
  }, [prefill?.nonce]);
  const [scrollBack, setScrollBack] = useState(0);
  const { frame } = useAnimation({ interval: ANIMATION_MS, isActive: !!busy });
  const inner = width - 3; // minus the borders and the scrollbar

  const [openSteps, setOpenSteps] = useState<Set<ChatEntry>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const history = useMemo(() => {
    const out: Line[] = [];
    for (let i = 0; i < entries.length; ) {
      if (entries[i]!.kind !== "tool") {
        out.push(...cachedLines(entries[i]!, inner));
        i++;
        continue;
      }
      // A run of steps: one alone is shown as is, two or more fold into a line.
      let j = i;
      while (j < entries.length && entries[j]!.kind === "tool") j++;
      const steps = entries.slice(i, j);
      if (steps.length === 1) out.push(...cachedLines(steps[0]!, inner));
      else out.push(...stepLines(steps, allOpen || openSteps.has(steps[0]!), !!busy && j === entries.length, inner));
      i = j;
    }
    return out;
  }, [entries, inner, openSteps, allOpen, !!busy]);
  const lines = useMemo(
    () => (streaming ? [...history, ...entryLines({ kind: "assistant", text: closeOpenMarkdown(streaming) }, inner, false)] : history),
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
    footer.push({ text: `🔌 ${approval.name.startsWith("mcp__") ? `MCP tool ${approval.name.split("__")[1]} → ${approval.name.split("__").slice(2).join("__")}` : `Plugin tool: ${approval.name}`}`, color: C.yellow, bold: true });
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
  for (const text of queued) {
    footer.push({ text: `⏳ next: ${text.replace(/\s+/g, " ")}`, color: C.dim });
  }

  // Typing "/" opens a menu of commands with what each does; ↑↓ pick one, Tab completes, Enter runs it.
  const menuOpen = focused && !approval && input.startsWith("/") && !input.includes(" ") && !input.includes("\n");
  const matches = useMemo(() => (menuOpen ? matchCommands(input, extraCommands) : []), [menuOpen, input, extraCommands]);
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

  // Clicking a file named in a message opens it in the code view.
  useEffect(() => {
    if (!click) return;
    const line = visible[click.row];
    const run = line?.toggle;
    if (run) {
      setOpenSteps((open) => {
        const next = new Set(open);
        if (next.has(run) || allOpen) next.delete(run);
        else next.add(run);
        return next;
      });
      if (allOpen) setAllOpen(false);
      return;
    }
    const ref = line?.spans ? linkAt(line.spans, click.col) : null;
    if (ref) onOpenRef?.(ref);
  }, [click?.nonce]);

  // Drag over the messages to select them (in lines of the conversation, so it holds while it scrolls);
  // letting go copies them. Dragging past the top or bottom scrolls.
  const [selection, setSelection] = useState<{ from: Point; to: Point } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const anchor = useRef<Point | null>(null);
  useEffect(() => {
    if (!select) return;
    const at: Point = { line: Math.max(0, Math.min(lines.length - 1, firstShown + select.row)), col: Math.max(0, select.col) };
    if (select.kind === "press") {
      anchor.current = at;
      setSelection(null);
      return;
    }
    if (!anchor.current) return;
    if (select.kind === "drag") {
      if (select.row < 0) setScrollBack((b) => Math.min(maxBack, b + 1));
      else if (select.row >= rows) setScrollBack((b) => Math.max(0, b - 1));
    }
    const moved = at.line !== anchor.current.line || at.col !== anchor.current.col;
    const range = moved ? (at.line < anchor.current.line || (at.line === anchor.current.line && at.col < anchor.current.col) ? { from: at, to: anchor.current } : { from: anchor.current, to: at }) : null;
    setSelection(range);
    if (select.kind !== "release") return;
    anchor.current = null;
    if (!range) return;
    const text = lines.slice(range.from.line, range.to.line + 1).map((line, i, all) => {
      const t = lineText(line);
      return t.slice(i === 0 ? range.from.col : 0, i === all.length - 1 ? range.to.col + 1 : undefined).trimEnd();
    }).join("\n");
    void copyToClipboard(text).then((ok) => {
      setFlash(ok ? `Copied ${text.split("\n").length > 1 ? `${text.split("\n").length} lines` : "it"} ✓` : "Can't copy: press m, then select");
      setTimeout(() => setFlash(null), 2000);
    });
  }, [select?.nonce]);
  // Typing or new messages leave the selection be; a new conversation clears it.
  useEffect(() => {
    if (!entries.length) setSelection(null);
  }, [entries.length]);
  /** The selected columns of a line, if any. */
  const selectedIn = (index: number): [number, number] | null => {
    if (!selection || index < selection.from.line || index > selection.to.line) return null;
    return [index === selection.from.line ? selection.from.col : 0, index === selection.to.line ? selection.to.col + 1 : Infinity];
  };

  // While something waits for approval, y/n into an empty input answer it; any other key starts a message.
  useInput((typed) => {
    if (/^[yYnN]$/.test(typed)) onAnswer(/[yY]/.test(typed));
    else if (typed && typed >= " ") setInput(typed); // printable, not a control key
  }, { isActive: focused && !!approval && !input });

  useInput((input, key) => {
    if (key.pageUp || (key.upArrow && key.shift)) setScrollBack((b) => Math.min(maxBack, Math.min(b, maxBack) + Math.max(1, rows - 2)));
    else if (key.pageDown || (key.downArrow && key.shift)) setScrollBack((b) => Math.max(0, Math.min(b, maxBack) - Math.max(1, rows - 2)));
    else if (key.ctrl && key.home) setScrollBack(maxBack);
    else if (key.ctrl && input === "o") {
      // Open every run of steps, or fold them all (the ones opened by a click too).
      setAllOpen(!allOpen);
      if (allOpen) setOpenSteps(new Set());
    }
    else if (key.ctrl && key.end) setScrollBack(0);
  }, { isActive: focused });

  useInput((_input, key) => {
    if (key.upArrow && !key.shift) setMenuRow((r) => (r - 1 + matches.length) % matches.length);
    else if (key.downArrow && !key.shift) setMenuRow((r) => (r + 1) % matches.length);
    else if (key.tab && picked) complete(picked);
    else if (key.escape) setInput("");
  }, { isActive: focused && showMenu });

  const submit = (value: string, now = false) => {
    if (!value.trim() || approval) return;
    let text = value.trim();
    if (showMenu && picked) {
      // Enter runs the highlighted command; one that needs an argument is completed instead, to type it.
      if (picked.args?.startsWith("<")) return complete(picked);
      text = `/${picked.name}`;
    }
    setInput("");
    onSubmit(text, now);
  };

  const render = (line: Line, key: string | number, withLead = true) => (
    <Text key={key} wrap="truncate-end">
      {withLead && line.lead ? <Text color={line.leadColor ?? C.dim}>{line.lead}</Text> : null}
      {line.spans?.length
        ? line.spans.map((span, i) => (
          <Text key={i} bold={!!span.bold || !!line.bold} italic={!!span.italic} dimColor={!!span.dim && !span.link} underline={!!span.link} {...(span.link ? { color: C.cyan } : span.code ? { color: C.yellow } : line.color ? { color: line.color } : { color: C.text })}>{span.text}</Text>
        ))
        : <Text bold={!!line.bold} dimColor={!!line.dim} {...(line.color ? { color: line.color } : {})}>{line.text || " "}</Text>}
    </Text>
  );

  const empty = entries.length === 0 && !streaming;
  const title = (
    <>
      {" "}<Text color={C.accent2}>◆</Text> Chat
      {flash ? <Text color={C.green} bold>  {flash}</Text> : back
        ? unread
          ? <Text color={C.green} bold>  ↓ {unread} new lines below<Text color={C.dim}> · PgDn / wheel / Ctrl+End</Text></Text>
          : <Text color={C.yellow}>  ↑ scrolled {back} lines<Text color={C.dim}> · PgDn / wheel / Ctrl+End</Text></Text>
        : maxBack > 0 ? <Text color={C.dim}>  PgUp / wheel to scroll</Text> : null}
    </>
  );

  // The messages, rebuilt only when they or the scroll position change: typing, the context chip and the
  // spinner re-render the chat without touching its (often hundreds of) lines.
  const messages = useMemo(() => (
    <>
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
            {visible.map((line, i) => {
              const range = selectedIn(firstShown + i);
              if (!range) return render(line, firstShown + i, false);
              const t = lineText(line) || " ";
              return (
                <Text key={firstShown + i} wrap="truncate-end" color={C.text}>
                  {t.slice(0, range[0])}<Text inverse>{t.slice(range[0], range[1]) || " "}</Text>{t.slice(range[1])}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}
    </>
  ), [lines, firstShown, visible.length, selection, inner, empty]);

  return (
    <Pane title={title} width={width} height={height} focused={focused}>
      <Box flexDirection="row" height={rows}>
        <Box flexDirection="column" width={inner} flexShrink={0}>
          {messages}
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
                {c.args && inner >= 56 ? <Text color={C.dim}> {c.args}</Text> : null /* narrow: the description matters more */}
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
        placeholder={busy ? (inner >= 44 ? "Enter queues · Alt+Enter sends now · Esc stops" : "Enter queues · Esc stops") : showMenu ? "↑↓ choose · Tab complete · Enter run" : inner >= 44 ? "Ask anything · / for commands · ↑ history" : "Ask anything · / commands"}
      />
    </Pane>
  );
});
