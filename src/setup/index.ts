import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { describe, providers, resolveModel, type ModelChoice, type Provider } from "../providers/index.js";
import { sameModel } from "../providers/ollama.js";

/** An API key (and maybe a model) found in another coding tool's config. */
export type Borrowed = { tool: "Claude Code" | "Codex"; provider: "anthropic" | "openai"; model?: string };

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Claude Code keeps API settings in the "env" block of ~/.claude/settings.json. Only API keys are reused:
 * a Claude subscription login (claude.ai) belongs to Claude Code and isn't something other apps may use.
 */
function claudeCode(): { env: Record<string, string>; model?: string } | null {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const settings = readJson(path.join(dir, "settings.json"));
  const env: Record<string, string> = {};
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
    const value = settings?.env?.[name];
    if (typeof value === "string" && value) env[name] = value;
  }
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return null;
  // Aliases like "opus" only mean something to Claude Code; full ids work anywhere.
  const model = [settings?.env?.ANTHROPIC_MODEL, settings?.model].find((m) => typeof m === "string" && m.startsWith("claude-"));
  return { env, ...(model ? { model } : {}) };
}

/** Codex stores an API-key login in ~/.codex/auth.json (ChatGPT sign-ins aren't reusable) and its model in config.toml. */
function codex(): { env: Record<string, string>; model?: string } | null {
  const dir = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const key = readJson(path.join(dir, "auth.json"))?.OPENAI_API_KEY;
  if (typeof key !== "string" || !key) return null;
  let model: string | undefined;
  try {
    // Top-level keys only: everything before the first [section].
    const top = readFileSync(path.join(dir, "config.toml"), "utf-8").split(/^\s*\[/m)[0]!;
    const provider = top.match(/^\s*model_provider\s*=\s*"([^"]*)"/m)?.[1];
    const found = top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
    // Codex-only models need the Responses API, which Nou doesn't speak.
    if (found && (!provider || provider === "openai") && !found.includes("codex")) model = found;
  } catch {
    // no config.toml
  }
  return { env: { OPENAI_API_KEY: key }, ...(model ? { model } : {}) };
}

/**
 * Fills in API keys from Claude Code's and Codex's config for providers you haven't set up yourself.
 * Your environment and .env always win; nothing is written anywhere.
 */
export function borrowToolConfig(): Borrowed[] {
  const found: Borrowed[] = [];
  const sources = [
    { tool: "Claude Code" as const, provider: "anthropic" as const, read: claudeCode, has: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
    { tool: "Codex" as const, provider: "openai" as const, read: codex, has: ["OPENAI_API_KEY"] },
  ];
  for (const source of sources) {
    if (source.has.some((name) => process.env[name])) continue;
    const config = source.read();
    if (!config) continue;
    for (const [name, value] of Object.entries(config.env)) process.env[name] ??= value;
    found.push({ tool: source.tool, provider: source.provider, ...(config.model ? { model: config.model } : {}) });
  }
  return found;
}

/** A local server's models, or null if it isn't reachable within `ms`. */
async function localModels(provider: Provider, ms = 1500): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([provider.listModels(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const ollama = () => providers.find((x) => x.id === "ollama")!;

/**
 * First run (no model chosen yet): offer what's already on this machine (Ollama models, a running
 * LM Studio, API keys including ones from Claude Code or Codex) instead of always starting on Ollama.
 * Returns null to keep the default.
 */
export async function pickStartingModel(borrowed: Borrowed[]): Promise<ModelChoice | null> {
  const options: { choice: ModelChoice; hint: string }[] = [];
  const add = (choice: ModelChoice, hint: string) => {
    if (!options.some((o) => describe(o.choice) === describe(choice))) options.push({ choice, hint });
  };

  for (const b of borrowed) add(resolveModel(b.model ? `${b.provider}:${b.model}` : b.provider), `API key from ${b.tool}`);
  const s = p.spinner();
  s.start("Looking for models you already have...");
  const local = await Promise.all(providers.filter((x) => x.local).map(async (x) => ({ provider: x, models: await localModels(x) })));
  s.stop("Checked for models");
  for (const { provider, models } of local) {
    for (const model of (models ?? []).slice(0, provider.id === "ollama" ? 5 : 1)) add({ provider, model }, `${provider.label}, installed`);
  }
  for (const provider of providers.filter((x) => !x.local && !x.unavailable())) add({ provider, model: provider.defaultModel }, "API key found");

  if (!options.length) return null;
  if (options.length === 1) {
    p.log.info(`Found ${chalk.yellow(describe(options[0]!.choice))} (${options[0]!.hint}).`);
    return options[0]!.choice;
  }
  const download = `download ${ollama().defaultModel} with Ollama (free, runs locally)`;
  const picked = await p.select({
    message: "Which model should Nou use? (change it any time with /model)",
    options: [
      ...options.map((o, i) => ({ value: String(i), label: describe(o.choice), hint: o.hint })),
      ...(local.find((l) => l.provider.id === "ollama")?.models?.some((m) => sameModel(m, ollama().defaultModel)) ? [] : [{ value: "download", label: download }]),
    ],
  });
  if (p.isCancel(picked) || picked === "download") return null;
  return options[Number(picked)]!.choice;
}

const isLocalHost = () => /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(process.env.OLLAMA_HOST ?? "127.0.0.1");

/** The ollama executable: on PATH, or where the Windows installer puts it (PATH may not be updated yet). */
function ollamaBinary(): string | null {
  if (spawnSync("ollama", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0) return "ollama";
  const windows = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe");
  return process.platform === "win32" && existsSync(windows) ? windows : null;
}

const has = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;

function installCommand(): { command: string; args: string[]; shown: string } | null {
  if (process.platform === "win32") {
    return has("winget")
      ? { command: "winget", args: ["install", "--id", "Ollama.Ollama", "-e", "--accept-source-agreements", "--accept-package-agreements"], shown: "winget install Ollama.Ollama" }
      : null;
  }
  if (process.platform === "darwin") return has("brew") ? { command: "brew", args: ["install", "ollama"], shown: "brew install ollama" } : null;
  // Ollama's official Linux installer.
  return has("curl") ? { command: "sh", args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], shown: "curl -fsSL https://ollama.com/install.sh | sh" } : null;
}

/** Gets a local Ollama running, installing it first if you agree. Returns its models, or null if it isn't available. */
async function startOllama(): Promise<string[] | null> {
  if (!isLocalHost()) {
    p.log.warn(`Can't reach Ollama at ${process.env.OLLAMA_HOST}.`);
    return null;
  }
  let binary = ollamaBinary();
  if (!binary) {
    const install = installCommand();
    if (!install) {
      p.log.warn("Ollama isn't installed. Get it from https://ollama.com/download, or pick a cloud model with /model.");
      return null;
    }
    const ok = await p.confirm({ message: `Ollama (runs models locally, free) isn't installed. Install it now? ${chalk.dim(`(${install.shown})`)}` });
    if (ok !== true) return null;
    const result = spawnSync(install.command, install.args, { stdio: "inherit" });
    binary = ollamaBinary();
    if (result.status !== 0 || !binary) {
      p.log.warn("Installing Ollama didn't work. Get it from https://ollama.com/download.");
      return null;
    }
  }
  // The desktop installers usually start Ollama themselves; otherwise start the server in the background.
  let models = await localModels(ollama());
  if (models) return models;
  const s = p.spinner();
  s.start("Starting Ollama...");
  spawn(binary, ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  for (let i = 0; i < 20 && !models; i++) {
    await new Promise((r) => setTimeout(r, 500));
    models = await localModels(ollama());
  }
  s.stop(models ? "Ollama is running" : "Ollama didn't start");
  return models;
}

/** Downloads an Ollama model with a progress line. */
async function pullWithProgress(model: string): Promise<boolean> {
  const s = p.spinner();
  s.start(`Downloading ${model}...`);
  let last = "";
  try {
    await ollama().pull!(model, (status, percent) => {
      const line = `Downloading ${model}: ${percent === null ? status : `${percent}%`}`;
      if (line !== last) s.message((last = line));
    });
    s.stop(`Downloaded ${model}`);
    return true;
  } catch (error: any) {
    s.stop(`Couldn't download ${model}: ${error.message}`);
    return false;
  }
}

/**
 * When the model is an Ollama one: make sure Ollama runs and the model is downloaded, offering to install,
 * start and download what's missing (or to use a model you already have).
 */
export async function ensureLocalModel(choice: ModelChoice): Promise<ModelChoice> {
  if (choice.provider.id !== "ollama") return choice;
  const installed = (await localModels(choice.provider)) ?? (await startOllama());
  if (!installed) return choice;
  if (installed.some((m) => sameModel(m, choice.model))) return choice;

  const picked = await p.select({
    message: `${choice.model} isn't downloaded yet.`,
    options: [
      { value: "", label: `Download ${choice.model}`, hint: "a few GB, one time" },
      ...installed.slice(0, 8).map((m) => ({ value: m, label: `Use ${m}`, hint: "already installed" })),
    ],
  });
  if (p.isCancel(picked)) return choice;
  if (picked) return { provider: choice.provider, model: picked };
  await pullWithProgress(choice.model);
  return choice;
}
