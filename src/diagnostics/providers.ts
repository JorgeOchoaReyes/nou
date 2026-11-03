import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { NOU_HOME } from "../config/index.js";
import { onPath, projectBin, run } from "./process.js";
import type { Diagnostic, DiagnosticsProvider } from "./types.js";

const rel = (file: string) => path.relative(process.cwd(), path.resolve(process.cwd(), file)).replace(/\\/g, "/");

/** ESLint, using the project's own install and config, so results match `npm run lint`. */
export const eslintProvider: DiagnosticsProvider = {
  id: "eslint",
  name: "ESLint",
  checksText: true,
  matches: (file) => /\.(m|c)?(j|t)sx?$/.test(file),
  available: () => projectBin("eslint") !== null,
  async check(file, text) {
    const bin = projectBin("eslint");
    if (!bin) return [];
    const result = await run(process.execPath, [bin, "--stdin", "--stdin-filename", file, "--format", "json"], { input: text, timeout: 60_000 });
    let reports: any[];
    try {
      reports = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    return reports.flatMap((report) =>
      (report.messages ?? [])
        // "File ignored by config" isn't a real problem.
        .filter((m: any) => !(m.ruleId === null && /ignored/i.test(m.message)))
        .map((m: any): Diagnostic => ({
          file: rel(file),
          line: m.line ?? 1,
          col: m.column ?? 1,
          ...(m.endLine ? { endLine: m.endLine } : {}),
          ...(m.endColumn ? { endCol: m.endColumn } : {}),
          severity: m.severity === 2 ? "error" : "warning",
          message: m.message,
          source: "eslint",
          ...(m.ruleId ? { code: m.ruleId } : {}),
        })),
    );
  },
};

/** The TypeScript compiler over the whole project (type errors need the full picture). */
/**
 * tsc runs after every edit, and a full check of a mid-sized project is many CPU-seconds (on a laptop,
 * battery). Incremental checks reuse what didn't change. The build info lives in ~/.nou/cache, one file per
 * project, so the project's own files (and any tsBuildInfoFile it sets) are left alone.
 */
let incremental = true;
function buildInfoFile(): string {
  const id = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16);
  const dir = path.join(NOU_HOME, "cache", "tsc");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.tsbuildinfo`);
}

export const typescriptProvider: DiagnosticsProvider = {
  id: "typescript",
  name: "TypeScript",
  checksText: false,
  projectWide: true,
  matches: (file) => /\.(m|c)?tsx?$/.test(file),
  available: () => existsSync(path.join(process.cwd(), "tsconfig.json")) && projectBin("typescript", "tsc") !== null,
  async check() {
    const bin = projectBin("typescript", "tsc");
    if (!bin) return [];
    const args = [bin, "--noEmit", "-p", ".", "--pretty", "false"];
    let result = await run(process.execPath, incremental ? [...args, "--incremental", "--tsBuildInfoFile", buildInfoFile()] : args, { timeout: 180_000 });
    // An option this project's tsconfig rules out (a TS5xxx/TS6xxx error that names no file): check it the
    // plain way from now on.
    if (incremental && /^error TS[56]\d{3}:/m.test(result.stdout)) {
      incremental = false;
      result = await run(process.execPath, args, { timeout: 180_000 });
    }
    const diagnostics: Diagnostic[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/);
      if (m) {
        diagnostics.push({
          file: rel(m[1]!),
          line: Number(m[2]),
          col: Number(m[3]),
          severity: m[4] === "error" ? "error" : "warning",
          message: m[6]!,
          source: "tsc",
          code: m[5]!,
        });
      } else if (line.startsWith("  ") && diagnostics.length) {
        diagnostics[diagnostics.length - 1]!.message += ` ${line.trim()}`;
      }
    }
    return diagnostics;
  },
};

let ruffInstalled: boolean | undefined;

/** Ruff for Python, if it's installed. */
export const ruffProvider: DiagnosticsProvider = {
  id: "ruff",
  name: "Ruff (Python)",
  checksText: true,
  matches: (file) => /\.pyi?$/.test(file),
  available: () => (ruffInstalled ??= onPath("ruff")),
  async check(file, text) {
    const result = await run("ruff", ["check", "--output-format", "json", "--stdin-filename", file, "-"], { input: text, timeout: 30_000 });
    let items: any[];
    try {
      items = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    return items.map((item): Diagnostic => ({
      file: rel(file),
      line: item.location?.row ?? 1,
      col: item.location?.column ?? 1,
      ...(item.end_location ? { endLine: item.end_location.row, endCol: item.end_location.column } : {}),
      // Syntax errors (no code / E9) and pyflakes (F) are real bugs; style rules are warnings.
      severity: !item.code || /^(E9|F)/.test(item.code) ? "error" : "warning",
      message: item.message,
      source: "ruff",
      ...(item.code ? { code: item.code } : {}),
    }));
  },
};
