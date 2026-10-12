import path from "path";
import fs from "fs/promises";
import { readdirSync } from "fs";
import { exec } from "child_process";

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
  const start = Math.max(1, Math.floor(offset) || 1);
  if (start > lines.length) return `(The file has ${lines.length} lines.)`;
  let end = Math.min(lines.length, start + Math.max(1, Math.floor(limit) || READ_LINES) - 1);
  if (start === 1 && end === lines.length && text.length <= READ_CHARS) return text;
  let body = lines.slice(start - 1, end).join("\n");
  if (body.length > READ_CHARS) {
    body = body.slice(0, READ_CHARS);
    end = start + body.split("\n").length - 1;
    body = `${body}\n[... line ${end} cut off: it is very long]`;
  }
  const more = end < lines.length ? ` Read more with offset=${end + 1}.` : "";
  return `${body}\n\n[Lines ${start}-${end} of ${lines.length}.${more}]`;
}

/** Keeps tool output a sensible size for the model: the start and, where errors usually are, the end. */
export function capOutput(text: string, max = 40_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters cut ...]\n\n${text.slice(-tail)}`;
}

export function runCommand(command: string): Promise<string> {
  // Async so the UI keeps rendering while the command runs.
  return new Promise((resolve) => {
    exec(command, { cwd: process.cwd(), timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = error.killed ? "timed out after 2 minutes" : `Exit Code ${error.code ?? "?"}`;
        resolve(`Error (${reason}): ${stderr || error.message}${stdout ? `
${stdout}` : ""}`);
      } else {
        resolve(stdout);
      }
    });
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

/** Works out what edit_file would do, without touching the disk. */
export async function proposeEdit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<FileChange> {
  const fullPath = resolveInProject(filePath);
  const before = await readOrEmpty(fullPath);
  if (before === null) throw new Error(`${filePath} does not exist. Use write_file to create it.`);

  // Models often send LF while Windows files use CRLF, so match on normalized text.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const normalized = before.replace(/\r\n/g, "\n");
  const target = oldString.replace(/\r\n/g, "\n");
  const count = target ? normalized.split(target).length - 1 : 0;
  if (count === 0) throw new Error("old_string was not found in the file. Read the file and copy the text exactly.");
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string appears ${count} times. Include more surrounding lines so it is unique, or set replace_all to change every one.`);
  }

  const replacement = newString.replace(/\r\n/g, "\n");
  const after = (replaceAll ? normalized.split(target).join(replacement) : normalized.replace(target, () => replacement)).replace(/\n/g, eol);
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
