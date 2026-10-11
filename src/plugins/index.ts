import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { NOU_HOME } from "../config/index.js";
import type { ToolDef } from "../providers/types.js";

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
};

export type PluginEntry = {
  id: string;
  file: string;
  scope: "project" | "user";
  plugin?: NouPlugin;
  error?: string;
};

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
