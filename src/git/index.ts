import { execFile, execFileSync } from "child_process";
import path from "path";
import type { FileChange } from "../commands/index.js";

/** Short status code per file, relative to the working directory: M, A, D, R, ?, U. */
export type GitStatus = Map<string, string>;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 20 * 1024 * 1024 });
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

let rootCache: string | null | undefined;
export function repoRoot(): string | null {
  if (rootCache === undefined) rootCache = tryGit(["rev-parse", "--show-toplevel"])?.trim() || null;
  return rootCache;
}

export const isRepo = () => repoRoot() !== null;

/** Repo-root-relative path (what git prints) -> cwd-relative path (what the UI uses). */
function fromRoot(p: string): string {
  return path.relative(process.cwd(), path.join(repoRoot()!, p)).replace(/\\/g, "/");
}

function toRoot(p: string): string {
  return path.relative(repoRoot()!, path.resolve(process.cwd(), p)).replace(/\\/g, "/");
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-uall"];

export function status(): GitStatus {
  return isRepo() ? parseStatus(tryGit(STATUS_ARGS)) : new Map();
}

/** status() without blocking: for background refreshes, where a large repo can take a while. */
export function statusAsync(): Promise<GitStatus> {
  if (!isRepo()) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile("git", STATUS_ARGS, { cwd: process.cwd(), encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }, (error, out) => resolve(parseStatus(error ? null : out)));
  });
}

export const sameStatus = (a: GitStatus, b: GitStatus) => a.size === b.size && [...a].every(([file, code]) => b.get(file) === code);

function parseStatus(out: string | null): GitStatus {
  const result: GitStatus = new Map();
  if (!out) return result;
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = fromRoot(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // the next part is the old name
    const code = xy === "??" ? "?"
      : xy.includes("U") ? "U"
        : xy.includes("D") ? "D"
          : xy.includes("A") ? "A"
            : xy[0] === "R" ? "R"
              : "M";
    if (!file.startsWith("..")) result.set(file, code);
  }
  return result;
}

/** The file as of the last commit, or null if it isn't tracked. */
export function headContent(file: string): string | null {
  if (!isRepo()) return null;
  return tryGit(["show", `HEAD:${toRoot(file)}`]);
}

/** Working copy vs HEAD as a FileChange, for the side-by-side diff view. */
export function diffAgainstHead(file: string, current: string): FileChange | null {
  const before = headContent(file);
  if (before === current.replace(/\r\n/g, "\n") || before === current) return null;
  return { path: file, before: before ?? "", after: current, isNew: before === null };
}

export function branch(): string {
  return tryGit(["branch", "--show-current"])?.trim() || "(detached)";
}

export function log(count = 10): string {
  return tryGit(["log", `-${Math.min(Math.max(count, 1), 50)}`, "--pretty=format:%h %ad %an: %s", "--date=short"])?.trim() || "(no commits)";
}

export function diffText(file?: string, staged = false): string {
  const args = ["diff", ...(staged ? ["--staged"] : ["HEAD"]), "--stat", "--patch"];
  if (file) args.push("--", toRoot(file));
  const out = tryGit(args) ?? tryGit(["diff", ...(file ? ["--", toRoot(file)] : [])]) ?? "";
  const untracked = file && status().get(file) === "?" ? `${file} is untracked (new file, not in git yet).` : "";
  const text = (out.trim() || untracked || "No changes.");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n... (diff truncated)` : text;
}

/** A compact snapshot for the system prompt. */
export function summary(): string | null {
  if (!isRepo()) return null;
  const changes = [...status()].map(([file, code]) => `  ${code} ${file}`);
  return `Git: use the git_status, git_diff and git_log tools (they need no approval) rather than running git with run_command.
Branch: ${branch()}
Uncommitted changes (at session start):
${changes.length ? changes.slice(0, 40).join("\n") + (changes.length > 40 ? `\n  ... ${changes.length - 40} more` : "") : "  (clean)"}
Recent commits:
${log(5).split("\n").map((l) => `  ${l}`).join("\n")}`;
}
