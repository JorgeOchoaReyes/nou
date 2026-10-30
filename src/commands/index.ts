import path from "path";
import fs from "fs/promises";
import { readdirSync } from "fs";
import { spawn } from "child_process";

export const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

export type FileChange = {
  path: string;
  before: string;
  after: string;
  isNew: boolean;
};

/** Whether a path is inside the project folder (where Nou may read without asking and write at all). */
export function isInProject(filePath: string): boolean {
  const rel = path.relative(process.cwd(), path.resolve(process.cwd(), filePath));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveInProject(filePath: string): string {
  const fullPath = path.resolve(process.cwd(), filePath);
  const rel = path.relative(process.cwd(), fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${filePath} is outside the project folder`);
  }
  return fullPath;
}

export function toRelative(filePath: string): string {
  return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).replace(/\\/g, "/");
}

export async function readFile(filepath: string): Promise<string> {
  try {
    const fullPath = path.resolve(process.cwd(), filepath);
    const content = await fs.readFile(fullPath, "utf-8");
    return content;
  } catch {
    return "Error: File not found or could not be read.";
  }
};

/** Lines read_file returns by default, and the most characters it returns at once. */
export const READ_LINES = 1000;
const READ_CHARS = 40_000;

/**
 * read_file for the model: a window of lines (1-based `offset`), with a note saying how to read on when the
 * file is longer, so a big file can't flood the model's context.
 */
export async function readForModel(filePath: string, offset = 1, limit = READ_LINES): Promise<string> {
  const text = await fs.readFile(path.resolve(process.cwd(), filePath), "utf-8");
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (text === "") return "(The file is empty.)";
  const start = Math.max(1, Math.floor(offset) || 1);
  if (start > lines.length) return `(The file has ${lines.length} lines.)`;
  let end = Math.min(lines.length, start + Math.max(1, Math.floor(limit) || READ_LINES) - 1);
  // Numbered like cat -n, so the model can cite and target exact lines (edit_file ignores the numbers).
  const width = String(end).length;
  let body = "";
  for (let n = start; n <= end; n++) {
    const line = `${String(n).padStart(width)}\t${lines[n - 1]}\n`;
    if (body.length + line.length > READ_CHARS) {
      end = n - 1;
      body += `[... stopped at line ${end} to keep this short]\n`;
      break;
    }
    body += line;
  }
  if (start === 1 && end === lines.length) return body.trimEnd();
  const more = end < lines.length ? ` Read more with offset=${end + 1}.` : "";
  return `${body}\n[Lines ${start}-${end} of ${lines.length}.${more}]`;
}

/** Keeps tool output a sensible size for the model: the start and, where errors usually are, the end. */
export function capOutput(text: string, max = 40_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters cut ...]\n\n${text.slice(-tail)}`;
}

/** How long run_command waits by default, and at most. */
export const COMMAND_TIMEOUT = 120_000;
export const MAX_COMMAND_TIMEOUT = 600_000;
/** Output kept from a command: the start and the end (where errors and summaries are) when it's longer. */
const OUTPUT_KEEP = 200_000;

/**
 * Runs a shell command and returns its output (stdout and stderr together, in the order written) and,
 * when it failed, its exit code. Async so the UI keeps rendering while it runs.
 */
export function runCommand(command: string, timeout = COMMAND_TIMEOUT): Promise<string> {
  return new Promise((resolve) => {
    const posix = process.platform !== "win32";
    // Its own process group on macOS and Linux, so a timeout stops everything it started.
    const child = spawn(command, { cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"], detached: posix });
    let head = "";
    let tail = "";
    let dropped = 0;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (head.length < OUTPUT_KEEP / 2) {
        head += text;
        return;
      }
      tail += text;
      if (tail.length > OUTPUT_KEEP / 2) {
        dropped += tail.length - OUTPUT_KEEP / 2;
        tail = tail.slice(-OUTPUT_KEEP / 2);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, Math.min(Math.max(1000, timeout), MAX_COMMAND_TIMEOUT));
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      const output = (dropped ? `${head}\n[... ${dropped} characters cut ...]\n${tail}` : head + tail).trimEnd();
      if (error) return resolve(`Error: ${error.message}`);
      if (timedOut) return resolve(`Error (timed out after ${Math.round(timeout / 1000)}s; pass a longer timeout if it needs one):\n${output}`);
      resolve(code === 0 ? output || "(no output)" : `Error (exit code ${code ?? "?"}):\n${output || "(no output)"}`);
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

export function fileTree(dir = ".", maxDepth = 3, maxLines = Infinity): string {
  const lines: string[] = [];
  let hidden = 0;
  const walk = (current: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .filter((e) => !IGNORED.has(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (lines.length >= maxLines) {
        hidden++;
        continue;
      }
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(path.join(current, entry.name), depth + 1, prefix + "  ");
    }
  };
  walk(path.resolve(process.cwd(), dir), 1, "");
  if (hidden) lines.push("[... more entries not shown; use glob, grep or list_files on a folder]");
  return lines.join("\n") || "(empty)";
}

/**
 * Undoes common model mistakes in write_file content without touching real code:
 * - a whole file sent as one line with literal "\n" escapes (no real newlines at all) is unescaped;
 *   files that already have real newlines are left alone, so "\n" inside strings and regexes survives
 * - a whole file wrapped in a markdown code fence is unwrapped
 * Indentation and blank lines are kept; a final newline is added if missing.
 */
export function cleanContent(content: string): string {
  let text = content;
  if (!text.includes("\n") && text.includes("\\n")) {
    text = text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
  }
  const fenced = text.match(/^\s*```[\w+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced) text = fenced[1]!;
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

async function readOrEmpty(fullPath: string): Promise<string | null> {
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/** Works out what write_file would do, without touching the disk. */
export async function proposeWrite(filePath: string, content: string): Promise<FileChange> {
  const fullPath = resolveInProject(filePath);
  const before = await readOrEmpty(fullPath);
  return { path: toRelative(filePath), before: before ?? "", after: cleanContent(content), isNew: before === null };
}

/** Typographic characters models sometimes put in place of the plain ones in the file. */
const PLAIN: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u201c": "\"", "\u201d": "\"", "\u2013": "-", "\u2014": "-", "\u00a0": " ", "\u2026": "..." };
const plainChars = (s: string) => s.replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u00a0\u2026]/g, (c) => PLAIN[c]!);

/**
 * Where `target` is in `text`, matching whole lines loosely: ignoring trailing spaces, then indentation,
 * then typographic quotes and dashes. Only a unique match counts: a wrong edit is worse than none.
 */
function looseMatch(text: string, target: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const want = target.replace(/\n$/, "").split("\n");
  const offsets: number[] = [];
  for (let i = 0, at = 0; i < lines.length; i++) {
    offsets.push(at);
    at += lines[i]!.length + 1;
  }
  for (const norm of [(l: string) => l.trimEnd(), (l: string) => l.trim(), (l: string) => plainChars(l).trim()]) {
    const wanted = want.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + wanted.length <= lines.length && hits.length < 2; i++) {
      if (wanted.every((w, k) => norm(lines[i + k]!) === w)) hits.push(i);
    }
    if (hits.length === 1) {
      const first = hits[0]!;
      const last = first + wanted.length - 1;
      return { start: offsets[first]!, end: offsets[last]! + lines[last]!.length };
    }
    if (hits.length > 1) return null;
  }
  return null;
}

/** The lines of `text` most like the start of `target`, numbered: a hint for the model's next try. */
function nearest(text: string, target: string): string {
  const lines = text.split("\n");
  const first = target.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!first) return "";
  const words = new Set(first.split(/\W+/).filter((w) => w.length > 2));
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const score = line.split(/\W+/).filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best < 0) return "";
  const from = Math.max(0, best - 2);
  return lines.slice(from, best + 4).map((l, k) => `${String(from + k + 1).padStart(5)}\t${l}`).join("\n");
}

/** Line numbers copied from read_file's output ("  12\tcode"): dropped when old_string doesn't match with them. */
const stripLineNumbers = (s: string) => (s.split("\n").every((l) => !l || /^\s*\d+\t/.test(l)) ? s.replace(/^\s*\d+\t/gm, "") : s);

/** Works out what edit_file would do, without touching the disk. */
export async function proposeEdit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<FileChange> {
  const fullPath = resolveInProject(filePath);
  const before = await readOrEmpty(fullPath);
  if (before === null) throw new Error(`${filePath} does not exist. Use write_file to create it.`);
  const after = editText(before, oldString, newString, replaceAll);
  return { path: toRelative(filePath), before, after, isNew: false };
}

/** Applies one edit to a file's text (see proposeEdit), throwing an error the model can act on. */
export function editText(before: string, oldString: string, newString: string, replaceAll = false): string {
  // Models often send LF while Windows files use CRLF, so match on normalized text.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const normalized = before.replace(/\r\n/g, "\n");
  let target = oldString.replace(/\r\n/g, "\n");
  let replacement = newString.replace(/\r\n/g, "\n");
  if (!target) throw new Error("old_string is empty. To create a file use write_file; to add to one, include the line you're adding after.");
  let count = normalized.split(target).length - 1;
  if (count === 0 && stripLineNumbers(target) !== target) {
    target = stripLineNumbers(target);
    replacement = stripLineNumbers(replacement);
    count = normalized.split(target).length - 1;
  }
  if (count === 0) {
    const loose = looseMatch(normalized, target);
    if (loose) return (normalized.slice(0, loose.start) + replacement.replace(/\n$/, "") + normalized.slice(loose.end)).replace(/\n/g, eol);
    const near = nearest(normalized, target);
    throw new Error(`old_string was not found in the file. Copy it exactly from read_file (without the line numbers).${near ? ` The closest lines are:\n${near}` : " Read the file again first."}`);
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string appears ${count} times. Include more surrounding lines so it is unique, or set replace_all to change every one.`);
  }
  return (replaceAll ? normalized.split(target).join(replacement) : normalized.replace(target, () => replacement)).replace(/\n/g, eol);
}

/** edit_file with several edits: each applies to the result of the one before, and all must work. */
export async function proposeEdits(filePath: string, edits: { old_string: string; new_string: string; replace_all?: boolean }[]): Promise<FileChange> {
  const fullPath = resolveInProject(filePath);
  const before = await readOrEmpty(fullPath);
  if (before === null) throw new Error(`${filePath} does not exist. Use write_file to create it.`);
  let after = before;
  edits.forEach((e, i) => {
    try {
      after = editText(after, String(e.old_string ?? ""), String(e.new_string ?? ""), e.replace_all === true);
    } catch (error: any) {
      throw new Error(`Edit ${i + 1} of ${edits.length}: ${error.message} (none of the edits were made)`, { cause: error });
    }
  });
  return { path: toRelative(filePath), before, after, isNew: false };
}

export async function applyChange(change: FileChange): Promise<string> {
  try {
    const fullPath = resolveInProject(change.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, change.after, "utf-8");
    return `Successfully ${change.isNew ? "created" : "updated"} ${change.path}`;
  } catch (error: any) {
    return `Failed to write file: ${error.message}`;
  }
}
