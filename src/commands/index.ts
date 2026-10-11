import path from "path";
import fs from "fs/promises";
import { readdirSync } from "fs";
import shelljs from "shelljs";

export const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

export type FileChange = {
  path: string;
  before: string;
  after: string;
  isNew: boolean;
};

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

export async function runCommand(command: string): Promise<string> {
  const result = shelljs.exec(command, { silent: true });
  if (result.code !== 0) {
    return `Error (Exit Code ${result.code}): ${result.stderr}`;
  }
  return result.stdout;
}

export function fileTree(dir = ".", maxDepth = 3): string {
  const lines: string[] = [];
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
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(path.join(current, entry.name), depth + 1, prefix + "  ");
    }
  };
  walk(path.resolve(process.cwd(), dir), 1, "");
  return lines.join("\n") || "(empty)";
}

function cleanContent(content: string): string {
  return content
    .replace(/\\n/g, "\n")
    .replace(/^```[a-z]*\n/i, "")
    .replace(/\n```$/g, "")
    .trim() + "\n";
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
export async function proposeEdit(filePath: string, oldString: string, newString: string): Promise<FileChange> {
  const fullPath = resolveInProject(filePath);
  const before = await readOrEmpty(fullPath);
  if (before === null) throw new Error(`${filePath} does not exist. Use write_file to create it.`);

  // Models often send LF while Windows files use CRLF, so match on normalized text.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const normalized = before.replace(/\r\n/g, "\n");
  const target = oldString.replace(/\r\n/g, "\n");
  const count = target ? normalized.split(target).length - 1 : 0;
  if (count === 0) throw new Error("old_string was not found in the file. Read the file and copy the text exactly.");
  if (count > 1) throw new Error(`old_string appears ${count} times. Include more surrounding lines so it is unique.`);

  const after = normalized.replace(target, () => newString.replace(/\r\n/g, "\n")).replace(/\n/g, eol);
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
