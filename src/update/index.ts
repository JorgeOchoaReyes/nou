import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NOU_HOME } from "../config/index.js";

export const PACKAGE_NAME = "nou-cli";
const CACHE = path.join(NOU_HOME, "update.json");
const DAY = 24 * 60 * 60 * 1000;

/** Nou's own package.json (works from source and from the installed dist build). */
function ownPackage(): { version: string; dir: string } {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf-8"));
      if (pkg.name === PACKAGE_NAME) return { version: pkg.version, dir };
    }
    dir = path.dirname(dir);
  }
  return { version: "0.0.0", dir };
}

export const currentVersion = () => ownPackage().version;

/** Running from a git checkout (npm run dev) rather than an npm install: never nag about updates. */
export const isDevCheckout = () => existsSync(path.join(ownPackage().dir, ".git"));

/** -1, 0 or 1. Plain x.y.z comparison; pre-release tags sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main!.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

async function fetchLatest(timeout: number): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return (await res.json()).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The newer version available on npm, or null. Asks npm at most once a day (cached in ~/.nou/update.json)
 * and never waits more than `timeout` ms, so startup stays fast offline.
 */
export async function checkForUpdate({ force = false, timeout = 1500 } = {}): Promise<string | null> {
  if (!force && (process.env.NOU_NO_UPDATE_CHECK || isDevCheckout())) return null;
  let latest: string | null = null;
  try {
    const cached = JSON.parse(readFileSync(CACHE, "utf-8"));
    if (!force && Date.now() - cached.checkedAt < DAY) latest = cached.latest;
  } catch {
    // no cache yet
  }
  if (!latest) {
    latest = await fetchLatest(timeout);
    if (latest) {
      try {
        mkdirSync(NOU_HOME, { recursive: true });
        writeFileSync(CACHE, JSON.stringify({ latest, checkedAt: Date.now() }));
      } catch {
        // caching is optional
      }
    }
  }
  return latest && compareVersions(latest, currentVersion()) > 0 ? latest : null;
}

/** Runs `npm install -g nou-cli@<version>`, showing npm's output. Resolves to success. */
export function installUpdate(version = "latest"): Promise<boolean> {
  return new Promise((resolve) => {
    // npm is npm.cmd on Windows, which needs a shell; the arguments are fixed, not user input.
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@${version}`], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Starts the freshly installed Nou in place of this process. */
export function relaunch(): void {
  const child = spawn(process.execPath, process.argv.slice(1).filter((a) => a !== "update"), { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 0));
}
