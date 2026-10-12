import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Agent, type AgentHooks } from "../agent/index.js";
import { NOU_HOME } from "../config/index.js";
import type { ModelChoice } from "../providers/index.js";
import { ClaudeCodeEngine } from "./claude.js";
import { CodexEngine } from "./codex.js";
import { PiEngine } from "./pi.js";
import { ENGINE_IDS, type Engine, type EngineId, type EngineInfo } from "./types.js";

export * from "./types.js";

/** Where optional engines are installed (`npm install --prefix`), so Nou itself stays small. */
export const ENGINE_DIR = process.env.NOU_ENGINE_DIR || path.join(NOU_HOME, "engines");

export const ENGINES: EngineInfo[] = [
  {
    id: "nou",
    label: "Nou",
    description: "Nou's own agent. Works with every model, local or cloud.",
    approvals: "before",
    model: (choice) => `${choice.provider.id}:${choice.model}`,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's agent (Claude Agent SDK). Claude models; uses your API key or Claude login.",
    package: "@anthropic-ai/claude-agent-sdk",
    approvals: "before",
    model: (choice) => (choice.provider.id === "anthropic" ? choice.model : "Claude Code's default model"),
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's agent (Codex SDK). OpenAI models; uses your API key or ChatGPT login. Edits in a sandbox without asking; review and undo after.",
    package: "@openai/codex-sdk",
    approvals: "after",
    model: (choice) => (choice.provider.id === "openai" ? choice.model : "Codex's default model"),
  },
  {
    id: "pi",
    label: "pi",
    description: "The minimal pi coding agent. Works with your Nou model, local or cloud.",
    package: "@earendil-works/pi-coding-agent",
    approvals: "before",
    model: (choice) => `${choice.provider.id}:${choice.model}`,
  },
];

export const engineInfo = (id: EngineId): EngineInfo => ENGINES.find((e) => e.id === id)!;
export const isEngineId = (id: string): id is EngineId => (ENGINE_IDS as readonly string[]).includes(id);

/** Where a package's ESM entry point is, under `node_modules` of `base`, or null if it isn't installed there. */
function entryPoint(base: string, pkg: string): string | null {
  const dir = path.join(base, "node_modules", ...pkg.split("/"));
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  const json = JSON.parse(readFileSync(manifest, "utf-8"));
  let entry = json.exports?.["."] ?? json.exports ?? json.module ?? json.main ?? "index.js";
  // Conditional exports: prefer import, then default (some nest them, e.g. { import: { default } }).
  while (entry && typeof entry === "object") entry = entry.import ?? entry.default ?? entry.node;
  return typeof entry === "string" ? path.join(dir, entry) : null;
}

/** Nou's own package folder (for engines installed as ordinary dependencies, e.g. in development). */
function ownDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5 && !existsSync(path.join(dir, "package.json")); i++) dir = path.dirname(dir);
  return dir;
}

function findPackage(pkg: string): string | null {
  return entryPoint(ENGINE_DIR, pkg) ?? entryPoint(ownDir(), pkg);
}

export const isInstalled = (info: EngineInfo) => !info.package || findPackage(info.package) !== null;

/** Imports an engine's package; it must be installed (see installEngine). */
export async function loadPackage(pkg: string): Promise<any> {
  const entry = findPackage(pkg);
  if (!entry) throw new Error(`${pkg} isn't installed. Pick the engine again in /settings to install it.`);
  return import(pathToFileURL(entry).href);
}

/** Installs an engine's package into ~/.nou/engines. `onLine` gets npm's output as it goes. */
export function installEngine(info: EngineInfo, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (!info.package) return Promise.resolve();
  mkdirSync(ENGINE_DIR, { recursive: true });
  const manifest = path.join(ENGINE_DIR, "package.json");
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "nou-engines", private: true }, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--prefix", ENGINE_DIR, "--no-audit", "--no-fund", info.package!], { shell: process.platform === "win32" });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);
    let tail = "";
    const read = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = line;
        onLine(line.trim());
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("stopped"));
      else if (code === 0) resolve();
      else reject(new Error(`npm install failed (exit ${code}): ${tail}`));
    });
  });
}

/** Creates the engine; external ones load their package when they first run. */
export function createEngine(id: EngineId, choice: ModelChoice, system: string, hooks: AgentHooks): Engine {
  switch (id) {
  case "claude-code":
    return new ClaudeCodeEngine(choice, hooks);
  case "codex":
    return new CodexEngine(choice, hooks);
  case "pi":
    return new PiEngine(choice, hooks);
  default:
    return new Agent(choice, system, hooks);
  }
}
