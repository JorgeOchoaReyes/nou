import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

export const NOU_HOME = path.join(os.homedir(), ".nou");
const CONFIG_PATH = path.join(NOU_HOME, "config.json");

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const AUTO_SAVE = ["delay", "focus", "off"] as const;
export type AutoSave = (typeof AUTO_SAVE)[number];

/** How fast follow mode replays what the agent does: a step every so often, or as it happens. */
export const FOLLOW_SPEEDS = ["slow", "normal", "fast", "instant"] as const;
export type FollowSpeed = (typeof FOLLOW_SPEEDS)[number];

/** Color themes for code (see src/syntax/themes.ts). */
export const CODE_THEMES = ["one-dark", "tokyo-night", "github-dark", "dracula", "high-contrast", "github-light"] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

export type Settings = {
  /** provider:model, e.g. "ollama:qwen3:8b". Empty means the built-in default. */
  model: string;
  /** Which agent runs the chat: "nou" (built in), "claude-code", "codex" or "pi". */
  engine: string;
  /** Reasoning effort for models that support it (Claude). */
  effort: Effort;
  /** Start with follow mode on (code view jumps to files the agent touches). */
  followMode: boolean;
  /** How fast follow mode shows each step. */
  followSpeed: FollowSpeed;
  /** Apply file edits without asking (the diff is still shown). */
  autoApproveEdits: boolean;
  /** Run shell commands without asking. */
  autoApproveCommands: boolean;
  /** Give the model the git branch/status/log and git tools. */
  gitContext: boolean;
  /** Editor auto-save: shortly after you stop typing, when you leave the editor, or never. */
  autoSave: AutoSave;
  /** Colors for code: syntax highlighting in the code view, editor and diffs. */
  codeTheme: CodeTheme;
  /** Mouse wheel scrolls the pane under the pointer; clicks focus panes and open files. */
  mouse: boolean;
  /** Use API keys from Claude Code's and Codex's config for providers you haven't set up. */
  reuseToolConfig: boolean;
  /** Pane widths as fractions of the terminal, set by dragging the borders or with < and >. Null means the default layout. */
  paneWidths: { tree: number; chat: number } | null;
  /** Folders you've said you trust: Nou reads their files and runs their MCP servers and plugins. */
  trustedFolders: string[];
  /** Games added to the Games panel (from settings → Games). */
  games: string[];
  /** The pane the Games panel docks under (it splits that pane's column); drag its title to another pane. */
  gameDock: "tree" | "code" | "chat";
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
  engine: "nou",
  effort: "high",
  followMode: false,
  followSpeed: "normal",
  autoApproveEdits: false,
  autoApproveCommands: false,
  gitContext: true,
  autoSave: "delay",
  codeTheme: "one-dark",
  mouse: true,
  reuseToolConfig: true,
  paneWidths: null,
  trustedFolders: [],
  games: [],
  gameDock: "chat",
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

/** Whether you trust this folder (or one it's inside). */
export function isTrustedFolder(dir = process.cwd(), settings: Settings = loadSettings()): boolean {
  const here = path.resolve(dir);
  return settings.trustedFolders.some((t) => here === t || here.startsWith(t.endsWith(path.sep) ? t : t + path.sep));
}
