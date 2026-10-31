import path from "path";
import { diffLines } from "diff";
import { highlightTree, notifySyntaxLoaded } from "../syntax/index.js";
import { highlightJsTheme } from "../syntax/themes.js";

// highlight.js registers every language it has when it loads (a seventh of a second), so it loads
// after Nou is on screen; files show plain until then, or tree-sitter colors once their grammar is in.
type CliHighlight = typeof import("cli-highlight");
let fallback: Pick<CliHighlight, "highlight" | "supportsLanguage"> | null = null;
let loading: Promise<void> | null = null;
export function loadFallbackHighlighter(): Promise<void> {
  loading ??= import("cli-highlight").then((m) => {
    fallback = { highlight: m.highlight, supportsLanguage: m.supportsLanguage };
    notifySyntaxLoaded();
  }, () => {});
  return loading;
}

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".json": "json", ".md": "markdown", ".css": "css", ".html": "xml",
  ".sh": "bash", ".ps1": "powershell", ".yml": "yaml", ".yaml": "yaml", ".go": "go",
  ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp", ".cs": "csharp", ".sql": "sql",
};

/** Splits file text into display lines: normalizes CRLF and expands tabs. */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function highlightLines(filePath: string, text: string): string[] {
  const plain = splitLines(text);
  // tree-sitter when the grammar is loaded (accurate); highlight.js otherwise.
  const tree = highlightTree(filePath, plain.join("\n"));
  if (tree) return tree;
  const language = LANGUAGES[path.extname(filePath).toLowerCase()];
  if (!language || text.length > 200_000) return plain;
  if (!fallback) {
    void loadFallbackHighlighter();
    return plain;
  }
  if (!fallback.supportsLanguage(language)) return plain;
  try {
    return fallback.highlight(plain.join("\n"), { language, ignoreIllegals: true, theme: highlightJsTheme() }).split("\n");
  } catch {
    return plain;
  }
}

/** Word-wraps plain text to the given width. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const max = Math.max(1, width);
  for (const raw of splitLines(text)) {
    if (raw.length <= max) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      if ((line + word).length <= max) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > max) {
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    out.push(line);
  }
  return out;
}

export type DiffCell = { n: number; text: string };
export type DiffRow = { left?: DiffCell; right?: DiffCell; changed: boolean };

/** Lines up before/after text into rows for a side by side diff. */
export function sideBySide(before: string, after: string): DiffRow[] {
  const parts = diffLines(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
  const rows: DiffRow[] = [];
  let ln = 1;
  let rn = 1;
  const cells = (value: string) => (value ? splitLines(value) : []);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of cells(part.value)) rows.push({ left: { n: ln++, text }, right: { n: rn++, text }, changed: false });
      continue;
    }
    const removed = part.removed ? cells(part.value) : [];
    let added = part.added ? cells(part.value) : [];
    if (part.removed && parts[i + 1]?.added) {
      added = cells(parts[++i]!.value);
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const row: DiffRow = { changed: true };
      if (k < removed.length) row.left = { n: ln++, text: removed[k]! };
      if (k < added.length) row.right = { n: rn++, text: added[k]! };
      rows.push(row);
    }
  }
  return rows;
}

/** 1-based line numbers in `after` that were added or changed. */
export function changedLines(before: string, after: string): Set<number> {
  const lines = new Set<number>();
  for (const row of sideBySide(before, after)) {
    if (row.changed && row.right) lines.add(row.right.n);
  }
  return lines;
}

/** Lines added and removed, for summaries like "+12 -3". */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"))) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** A file the text refers to, e.g. src/a.ts:12-20, which a click opens. */
/** Something clickable in the chat: a file (and lines) in the project, or a web address (`url`). */
export type FileRef = { path: string; line?: number; to?: number; url?: string };
export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; dim?: boolean; link?: FileRef };
export type MdLine = { spans: Span[]; kind: "text" | "heading" | "code" | "quote" | "rule" };

const INLINE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Splits a line of markdown into styled spans: `code`, **bold**, *italic*, [links](url). */
export function inlineSpans(text: string, base: Span = { text: "" }): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > pos) out.push({ ...base, text: text.slice(pos, m.index) });
    if (m[2] !== undefined) out.push({ ...base, text: m[2], code: true });
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...inlineSpans(m[3] ?? m[4]!, { ...base, bold: true }));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(...inlineSpans(m[5] ?? m[6]!, { ...base, italic: true }));
    else {
      // [text](https://...) links to the page; [text](file) is left for the file links.
      const web = /^https?:\/\//.test(m[8]!) ? { ...base, link: { path: "", url: m[8]! } } : base;
      out.push(...inlineSpans(m[7]!, web));
      if (m[8] !== m[7]) out.push({ ...web, text: ` (${m[8]})`, dim: true });
    }
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ ...base, text: text.slice(pos) });
  return out.filter((s) => s.text);
}

const sameStyle = (a: Span, b: Span) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.dim === !!b.dim && a.link === b.link;

/** Word-wraps styled spans; continuation lines start with `indent` spaces. */
function wrapSpans(spans: Span[], width: number, indent = 0): Span[][] {
  const max = Math.max(1, width);
  const lines: Span[][] = [[]];
  let len = 0;
  const push = (span: Span) => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last && sameStyle(last, span)) last.text += span.text;
    else line.push({ ...span });
    len += span.text.length;
  };
  const newLine = () => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last) last.text = last.text.trimEnd();
    lines.push(indent ? [{ text: " ".repeat(indent) }] : []);
    len = indent;
  };
  for (const span of spans) {
    for (const word of span.text.split(/(\s+)/)) {
      if (!word) continue;
      if (len + word.length <= max) {
        push({ ...span, text: word });
        continue;
      }
      if (/^\s+$/.test(word)) {
        newLine();
        continue;
      }
      if (len > indent) newLine();
      let rest = word;
      while (len + rest.length > max) {
        const room = Math.max(1, max - len);
        push({ ...span, text: rest.slice(0, room) });
        rest = rest.slice(room);
        newLine();
      }
      push({ ...span, text: rest });
    }
  }
  return lines;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Renders markdown for the terminal: headings, lists, quotes, code blocks, tables and inline styles, wrapped to `width`. */
export function renderMarkdown(text: string, width: number, isFile?: (file: string) => boolean): MdLine[] {
  // File references become links before wrapping, so a long path that wraps is still one link.
  // Web addresses first, so a file name inside a URL stays part of the URL.
  const spansOf = (line: string, base?: Span) => (isFile ? linkFileRefs(linkUrls(inlineSpans(line, base)), isFile) : linkUrls(inlineSpans(line, base)));
  const out: MdLine[] = [];
  const src = splitLines(text);
  let fence: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i]!;
    const opener = raw.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence !== null) {
      if (opener && raw.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
      for (const line of wrap(raw, width)) out.push({ kind: "code", spans: [{ text: line, code: true }] });
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      if (opener[2]) out.push({ kind: "code", spans: [{ text: opener[2], dim: true }] });
      continue;
    }
    // Tables: a header row, a |---| row, then body rows.
    if (/^\s*\|/.test(raw) && /^\s*\|?\s*:?-{2,}/.test(src[i + 1] ?? "")) {
      const rows = [cells(raw)];
      let j = i + 2;
      for (; j < src.length && /^\s*\|/.test(src[j]!); j++) rows.push(cells(src[j]!));
      i = j - 1;
      const plain = rows.map((r) => r.map((c) => spansOf(c).map((s) => s.text).join("")));
      const columns = Math.max(...plain.map((r) => r.length));
      const widths = Array.from({ length: columns }, (_, c) => Math.max(...plain.map((r) => (r[c] ?? "").length)));
      const fits = widths.reduce((a, b) => a + b, 0) + 3 * (columns - 1) <= width;
      rows.forEach((row, r) => {
        const spans: Span[] = [];
        row.forEach((cell, c) => {
          if (c > 0) spans.push({ text: " │ ", dim: true });
          spans.push(...spansOf(cell, r === 0 ? { text: "", bold: true } : { text: "" }));
          if (fits && c < columns - 1) spans.push({ text: " ".repeat(widths[c]! - plain[r]![c]!.length) });
        });
        for (const line of wrapSpans(spans, width, 2)) out.push({ kind: "text", spans: line });
        if (r === 0) out.push({ kind: "rule", spans: [{ text: fits ? widths.map((w) => "─".repeat(w)).join("─┼─") : "─".repeat(Math.min(width, 40)), dim: true }] });
      });
      continue;
    }
    const heading = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      for (const line of wrapSpans(spansOf(heading[2]!, { text: "", bold: true }), width)) out.push({ kind: "heading", spans: line });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push({ kind: "rule", spans: [{ text: "─".repeat(Math.min(width, 40)), dim: true }] });
      continue;
    }
    const quote = raw.match(/^\s*>\s?(.*)/);
    if (quote) {
      for (const line of wrapSpans(spansOf(quote[1]!, { text: "", italic: true }), width - 2)) out.push({ kind: "quote", spans: [{ text: "│ ", dim: true }, ...line] });
      continue;
    }
    const item = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)/);
    if (item) {
      const depth = Math.floor(item[1]!.length / 2) * 2;
      const task = item[3] ? (/x/i.test(item[3]) ? "☑ " : "☐ ") : "";
      const bullet = `${" ".repeat(depth)}${/\d/.test(item[2]!) ? item[2] : "•"} ${task}`;
      for (const line of wrapSpans([{ text: bullet }, ...spansOf(item[4]!)], width, bullet.length)) out.push({ kind: "text", spans: line });
      continue;
    }
    for (const line of wrapSpans(spansOf(raw), width)) out.push({ kind: "text", spans: line });
  }
  return out;
}

/**
 * path, path:line or path:line-line; a path has a dot in its last part, so plain words don't match.
 * Windows paths (C:\\dir\\file.ts, dir\\file.ts) count too.
 */
const FILE_REF = /(?<![\w/\\.@~-])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w@.~+-]+[\\/])*[\w@-][\w@.~+-]*\.[A-Za-z0-9]{1,8})(?::(\d+)(?:[-–](\d+))?)?(?![\w/\\])/g;

/** Splits out the references to files that exist (per `isFile`) as link spans, keeping each span's style. */
export function linkFileRefs(spans: Span[], isFile: (file: string) => boolean): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (span.link) {
      out.push(span);
      continue;
    }
    let pos = 0;
    for (const m of span.text.matchAll(FILE_REF)) {
      const file = m[1]!.replace(/^\.[\\/]/, "");
      if (!isFile(file)) continue;
      if (m.index > pos) out.push({ ...span, text: span.text.slice(pos, m.index) });
      const link: FileRef = { path: file };
      if (m[2]) link.line = Number(m[2]);
      if (m[3]) link.to = Number(m[3]);
      out.push({ ...span, text: m[0], link });
      pos = m.index + m[0].length;
    }
    if (pos < span.text.length) out.push(pos ? { ...span, text: span.text.slice(pos) } : span);
  }
  return out;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g;

/** Splits out web addresses (http:// and https://) as link spans, keeping each span's style. */
export function linkUrls(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (span.link || span.code || !span.text.includes("http")) {
      out.push(span);
      continue;
    }
    let pos = 0;
    for (const m of span.text.matchAll(URL_RE)) {
      if (m.index > pos) out.push({ ...span, text: span.text.slice(pos, m.index) });
      out.push({ ...span, text: m[0], link: { path: "", url: m[0] } });
      pos = m.index + m[0].length;
    }
    if (pos < span.text.length) out.push(pos ? { ...span, text: span.text.slice(pos) } : span);
  }
  return out;
}

/** The link at column `col` of a line of spans, if any. */
export function linkAt(spans: Span[], col: number): FileRef | null {
  let x = 0;
  for (const span of spans) {
    if (col >= x && col < x + span.text.length) return span.link ?? null;
    x += span.text.length;
  }
  return null;
}

// eslint-disable-next-line no-control-regex -- color codes start with ESC
const ESCAPE = /\x1b\[[\d;]*m/y;

/**
 * Columns `from` to `from + width` of a highlighted line, keeping its colors: the color codes before
 * `from` are kept (so the text still starts in the right color), the characters are dropped.
 */
export function sliceAnsi(line: string, from: number, width = Infinity): string {
  let out = "";
  let column = 0;
  for (let i = 0; i < line.length;) {
    ESCAPE.lastIndex = i;
    const code = ESCAPE.exec(line);
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (column >= from && column < from + width) out += ch;
    column++;
    i += ch.length;
  }
  return out;
}

/** Wraps visible columns `from`..`to` of a highlighted line in `open`/`close` codes (e.g. to mark a search match). */
export function markAnsi(line: string, from: number, to: number, open = "\x1b[7m", close = "\x1b[27m"): string {
  let out = "";
  let column = 0;
  for (let i = 0; i < line.length;) {
    ESCAPE.lastIndex = i;
    const code = ESCAPE.exec(line);
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (column === from) out += open;
    out += ch;
    column++;
    if (column === to) out += close;
    i += ch.length;
  }
  return out;
}

/**
 * A reply still streaming, with its open markdown closed for now (a code block, **bold**, `code`), so it
 * renders the way it will once finished instead of reflowing when the closing marker arrives.
 */
export function closeOpenMarkdown(text: string): string {
  const fences = text.match(/^\s*(`{3,}|~{3,})/gm)?.length ?? 0;
  if (fences % 2) return `${text}\n\`\`\``;
  const last = text.slice(text.lastIndexOf("\n") + 1);
  let out = text;
  if ((last.match(/`/g)?.length ?? 0) % 2) out += "`";
  else if ((last.match(/\*\*/g)?.length ?? 0) % 2) out += "**";
  return out;
}

/**
 * Regions that can fold, from indentation (like VS Code without a language server): a line followed by
 * more-indented lines folds them, and the closing bracket that ends the block. 1-based line -> last line.
 */
export function foldRanges(text: string): Map<number, number> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const indent = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, "  ").length;
  const blank = (s: string) => !s.trim();
  const out = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    const base = indent(lines[i]!);
    let j = i + 1;
    while (j < lines.length && blank(lines[j]!)) j++;
    if (j >= lines.length || indent(lines[j]!) <= base) continue;
    let end = j;
    for (let k = j; k < lines.length; k++) {
      if (blank(lines[k]!)) continue;
      if (indent(lines[k]!) <= base) break;
      end = k;
    }
    // The line that closes the block (`}`, `)`, `]`, `end`...) folds with it.
    const next = end + 1;
    if (next < lines.length && indent(lines[next]!) === base && /^\s*([}\])]|end\b|<\/)/.test(lines[next]!)) end = next;
    if (end > i) out.set(i + 1, end + 1);
  }
  return out;
}

/** The file lines (1-based) left showing with `folded` regions (start lines) closed. */
export function unfoldedLines(count: number, ranges: Map<number, number>, folded: Set<number>): number[] {
  const out: number[] = [];
  for (let n = 1; n <= count; n++) {
    out.push(n);
    if (folded.has(n) && ranges.has(n)) n = ranges.get(n)!;
  }
  return out;
}
