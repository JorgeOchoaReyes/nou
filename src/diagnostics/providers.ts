import { existsSync } from "fs";
import path from "path";
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
    const result = await run(process.execPath, [bin, "--noEmit", "-p", ".", "--pretty", "false"], { timeout: 180_000 });
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
