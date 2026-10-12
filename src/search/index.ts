import { execFileSync } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { IGNORED, isInProject, toRelative } from "../commands/index.js";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE = 200;

/**
 * The project's files, relative and with forward slashes: git's list when it's a repo (so .gitignore is
 * respected), otherwise a walk that skips the usual build and dependency folders.
 */
export function projectFiles(under = "."): string[] {
  const base = toRelative(under) || ".";
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", base], {
      cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    // ls-files also lists deleted-but-tracked files; keep the ones that exist.
    return out.split("\n").filter(Boolean).slice(0, MAX_FILES).filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES || IGNORED.has(entry.name)) continue;
        const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk(base);
    return files;
  }
}

/**
 * Glob to regex: `**` crosses folders, `*` and `?` stay within one, `{a,b}` is either. A pattern without a
 * slash matches the file name anywhere ("*.ts" finds src/x.ts), like most tools.
 */
export function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      // "**/" matches zero or more folders.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) source += "\\{";
      else {
        source += `(?:${pattern.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(pattern.includes("/") ? `^${source}$` : `(?:^|/)${source}$`);
}

/** Files matching a glob, newest first (recently changed files are usually the relevant ones). */
export function globFiles(pattern: string, under = ".", limit = 200): string {
  if (!isInProject(under)) return `${under} is outside the project folder.`;
  const regex = globToRegex(pattern.replace(/\\/g, "/").replace(/^\.\//, ""));
  const base = toRelative(under);
  const matches = projectFiles(under).filter((file) => regex.test(base && base !== "." ? path.posix.relative(base, file) : file) || regex.test(file));
  if (!matches.length) return `No files match ${pattern}.`;
  const dated = matches.map((file) => {
    try {
      return { file, time: statSync(file).mtimeMs };
    } catch {
      return { file, time: 0 };
    }
  });
  dated.sort((a, b) => b.time - a.time);
  const shown = dated.slice(0, limit).map((d) => d.file);
  return `${shown.join("\n")}${matches.length > limit ? `\n[${matches.length - limit} more; narrow the pattern]` : ""}`;
}

export type GrepOptions = {
  pattern: string;
  path?: string;
  /** Only search files matching this glob, e.g. "*.ts". */
  glob?: string;
  ignoreCase?: boolean;
  /** Lines of context around each match. */
  context?: number;
  /** List matching files instead of lines. */
  filesOnly?: boolean;
  limit?: number;
};

/** Searches file contents with a regex (or plain text, if the pattern isn't a valid regex). */
export function grep(options: GrepOptions): string {
  const { pattern, ignoreCase = false, filesOnly = false } = options;
  const under = options.path ?? ".";
  const limit = options.limit ?? 100;
  const context = Math.max(0, Math.min(5, options.context ?? 0));
  if (!pattern) return "Give a pattern to search for.";
  if (!isInProject(under)) return `${under} is outside the project folder.`;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
  }
  let files: string[];
  try {
    files = statSync(under).isFile() ? [toRelative(under)] : projectFiles(under);
  } catch {
    return `${under} doesn't exist.`;
  }
  if (options.glob) {
    const only = globToRegex(options.glob);
    files = files.filter((file) => only.test(file));
  }

  const out: string[] = [];
  const matchedFiles: string[] = [];
  let total = 0;
  let shownMatches = 0;
  for (const file of files) {
    let text: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split("\n");
    let inFile = 0;
    let lastShown = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      total++;
      inFile++;
      if (filesOnly || shownMatches >= limit) continue;
      shownMatches++;
      if (context && lastShown >= 0 && i - context > lastShown + 1) out.push("--");
      for (let j = Math.max(0, i - context, lastShown + 1); j <= Math.min(lines.length - 1, i + context); j++) {
        const line = lines[j]!.replace(/\r$/, "");
        const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line;
        out.push(`${file}:${j + 1}${j === i ? ":" : "-"} ${shown}`);
        lastShown = j;
      }
    }
    if (inFile) matchedFiles.push(`${file} (${inFile})`);
  }
  if (!total) return `No matches for ${pattern}${options.glob ? ` in ${options.glob} files` : ""}.`;
  if (filesOnly) {
    return `${matchedFiles.slice(0, limit).join("\n")}${matchedFiles.length > limit ? `\n[${matchedFiles.length - limit} more files]` : ""}`;
  }
  return `${out.join("\n")}${total > shownMatches ? `\n[${total} matches in ${matchedFiles.length} files; showing the first ${limit}. Narrow the pattern, path or glob, or use files_only.]` : ""}`;
}
