import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

export const NOU_HOME = path.join(os.homedir(), ".nou");
const CONFIG_PATH = path.join(NOU_HOME, "config.json");

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const AUTO_SAVE = ["delay", "focus", "off"] as const;
export type AutoSave = (typeof AUTO_SAVE)[number];

export type Settings = {
  /** provider:model, e.g. "ollama:qwen3:8b". Empty means the built-in default. */
  model: string;
  /** Reasoning effort for models that support it (Claude). */
  effort: Effort;
  /** Start with follow mode on (code view jumps to files the agent touches). */
  followMode: boolean;
  /** Apply file edits without asking (the diff is still shown). */
  autoApproveEdits: boolean;
  /** Run shell commands without asking. */
  autoApproveCommands: boolean;
  /** Give the model the git branch/status/log and git tools. */
  gitContext: boolean;
  /** Editor auto-save: shortly after you stop typing, when you leave the editor, or never. */
  autoSave: AutoSave;
  /** Built-in plugin id -> enabled (built-ins are on unless switched off). */
  plugins: Record<string, boolean>;
  /**
   * Your own plugins that you've switched on: plugin path -> hash of its code. A plugin only runs if this
   * exact file, with this exact content, was approved, so a same-named plugin in another repo never runs.
   */
  trustedPlugins: Record<string, string>;
};

export const DEFAULT_SETTINGS: Settings = {
  model: "",
  effort: "high",
  followMode: true,
  autoApproveEdits: false,
  autoApproveCommands: false,
  gitContext: true,
  autoSave: "delay",
  plugins: {},
  trustedPlugins: {},
};

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULT_SETTINGS, ...saved, plugins: { ...saved.plugins }, trustedPlugins: { ...saved.trustedPlugins } };
  } catch {
    return { ...DEFAULT_SETTINGS, plugins: {}, trustedPlugins: {} };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  try {
    if (!existsSync(NOU_HOME)) mkdirSync(NOU_HOME, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch {
    // settings are best effort; the session still uses them
  }
  return next;
}
