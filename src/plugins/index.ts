import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { NOU_HOME } from "../config/index.js";
import type { ToolDef } from "../providers/types.js";
import type { DiagnosticsProvider } from "../diagnostics/types.js";
import { eslintProvider, ruffProvider, typescriptProvider } from "../diagnostics/providers.js";
import { syntaxProvider } from "../syntax/index.js";
import { lsp } from "../lsp/index.js";

/**
 * Plugin API (early, will grow). A plugin is a .js/.mjs/.ts file (or a folder with an index file) in
 * `.nou/plugins/` of the project or `~/.nou/plugins/`, default-exporting a NouPlugin.
 * Plugins are disabled until switched on in /settings, since they run code on your machine.
 */
export type PluginContext = { cwd: string };

export type PluginTool = {
  definition: ToolDef;
  /** Read-only tools run without asking; everything else needs approval. */
  readOnly?: boolean;
  run(args: Record<string, any>, ctx: PluginContext): Promise<string> | string;
};

export type PluginCommand = {
  name: string;
  description: string;
  run(args: string, ctx: PluginContext): Promise<string | void> | string | void;
};

export type NouPlugin = {
  name: string;
  description?: string;
  version?: string;
  /** Extra instructions appended to the system prompt. */
  systemPrompt?: string;
  tools?: PluginTool[];
  commands?: PluginCommand[];
  /** Checkers (linters, type checkers...) whose problems show in the editor and are fed to the model. */
  diagnostics?: DiagnosticsProvider[];
};

export type PluginEntry = {
  id: string;
  file: string;
  scope: "project" | "user" | "built-in";
  plugin?: NouPlugin;
  error?: string;
};

/** Plugins that ship with Nou. On by default; they only run when the project has the tool installed. */
export const BUILTIN_PLUGINS: PluginEntry[] = [
  {
    id: "syntax",
    file: "(built-in)",
    scope: "built-in",
    plugin: { name: "Syntax check", description: "Instant syntax errors from the tree-sitter parser, no setup needed.", diagnostics: [syntaxProvider] },
  },
  {
    id: "eslint",
    file: "(built-in)",
    scope: "built-in",
    plugin: { name: "ESLint", description: "Lints JS/TS with your project's own ESLint and config.", diagnostics: [eslintProvider] },
  },
  {
    id: "typescript",
    file: "(built-in)",
    scope: "built-in",
    plugin: { name: "TypeScript", description: "Type errors from your project's own tsc (needs tsconfig.json).", diagnostics: [typescriptProvider] },
  },
  {
    id: "ruff",
    file: "(built-in)",
    scope: "built-in",
    plugin: { name: "Ruff", description: "Lints Python with ruff, if it's installed.", diagnostics: [ruffProvider] },
  },
  {
    id: "lsp",
    file: "(built-in)",
    scope: "built-in",
    plugin: {
      name: "Language servers",
      description: "Problems, hover (Ctrl+K) and go-to-definition (Ctrl+G) from installed servers: typescript-language-server, pyright, rust-analyzer, gopls, clangd.",
      diagnostics: [lsp.provider()],
    },
  },
];

/** Built-ins are on unless switched off; your own plugins are off until switched on. */
export function isEnabled(entry: PluginEntry, enabled: Record<string, boolean>): boolean {
  return entry.scope === "built-in" ? enabled[entry.id] !== false : enabled[entry.id] === true;
}

export const PLUGIN_DIRS = [
  { scope: "project" as const, dir: path.join(process.cwd(), ".nou", "plugins") },
  { scope: "user" as const, dir: path.join(NOU_HOME, "plugins") },
];

const EXTENSIONS = [".js", ".mjs", ".ts", ".mts"];

/** Finds plugin files without running them. */
export function discoverPlugins(): PluginEntry[] {
  const found: PluginEntry[] = [];
  for (const { scope, dir } of PLUGIN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      let file: string | undefined;
      if (statSync(full).isDirectory()) {
        file = EXTENSIONS.map((ext) => path.join(full, `index${ext}`)).find(existsSync);
      } else if (EXTENSIONS.includes(path.extname(name))) {
        file = full;
      }
      const id = path.basename(name, path.extname(name));
      if (file && !found.some((p) => p.id === id)) found.push({ id, file, scope });
    }
  }
  return found;
}

export async function loadPlugin(entry: PluginEntry): Promise<PluginEntry> {
  try {
    const mod = await import(pathToFileURL(entry.file).href);
    const plugin: NouPlugin | undefined = mod.default ?? mod.plugin;
    if (!plugin || typeof plugin.name !== "string") throw new Error("must default-export an object with a name");
    return { ...entry, plugin };
  } catch (error: any) {
    return { ...entry, error: error.message };
  }
}
