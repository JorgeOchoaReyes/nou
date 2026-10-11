import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";

export type ProcessResult = { code: number | null; stdout: string; stderr: string };

/** Runs a program without a shell (safe with any file name), optionally piping text to stdin. */
export function run(command: string, args: string[], options: { input?: string; timeout?: number } = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { cwd: process.cwd(), windowsHide: true });
    } catch (error: any) {
      resolve({ code: -1, stdout: "", stderr: error.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), options.timeout ?? 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Whether a program is on PATH (e.g. `ruff`). */
export function onPath(command: string): boolean {
  try {
    return spawnSync(command, ["--version"], { windowsHide: true, timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Finds a CLI installed in the user's project (not Nou's own copy), e.g. their ESLint,
 * returning the JS entry point so it can be run with `node` on every OS.
 */
export function projectBin(pkg: string, bin = pkg): string | null {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const manifestPath = require.resolve(`${pkg}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
    if (!rel) return null;
    const full = path.join(path.dirname(manifestPath), rel);
    // Only use it if it's really the project's install, not something hoisted from Nou itself.
    const inside = path.relative(process.cwd(), full);
    return existsSync(full) && !inside.startsWith("..") && !path.isAbsolute(inside) ? full : null;
  } catch {
    return null;
  }
}
