import { readFileSync } from "fs";
import os from "os";
import path from "path";
import type { McpServerConfig } from "./index.js";

/**
 * Finds the MCP servers you've set up in other AI tools, so Nou can use the same ones without setting them
 * up again: Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI and Codex.
 */
export type FoundServer = { name: string; config: McpServerConfig; from: string };

function json(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Keeps the fields Nou uses, from a server entry in any of these formats. */
function normalize(raw: any): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const out: McpServerConfig = {};
  if (typeof raw.command === "string") out.command = raw.command;
  if (Array.isArray(raw.args)) out.args = raw.args.map(String);
  if (raw.env && typeof raw.env === "object") out.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]));
  if (typeof raw.cwd === "string") out.cwd = raw.cwd;
  const url = raw.url ?? raw.serverUrl ?? raw.httpUrl;
  if (typeof url === "string") out.url = url;
  if (raw.headers && typeof raw.headers === "object") out.headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]));
  if (raw.disabled === true) out.disabled = true;
  return out.command || out.url ? out : null;
}

/** The [mcp_servers.<name>] tables of a Codex config.toml (just the keys MCP servers use). */
export function codexServers(toml: string): Record<string, McpServerConfig> {
  const out: Record<string, any> = {};
  let current: any = null;
  let sub: string | null = null;
  const value = (v: string): any => {
    v = v.trim();
    if (v.startsWith("\"") || v.startsWith("'")) return v.slice(1, v.lastIndexOf(v[0]!)).replace(/\\"/g, "\"");
    if (v.startsWith("[")) return [...v.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    if (v.startsWith("{")) return Object.fromEntries([...v.matchAll(/([\w-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g)].map((m) => [m[1], m[2]]));
    if (v === "true" || v === "false") return v === "true";
    return v;
  };
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const table = line.match(/^\[mcp_servers\.("?)([^"\].]+)\1(?:\.(\w+))?\]$/);
    if (table) {
      out[table[2]!] ??= {};
      current = out[table[2]!];
      sub = table[3] ?? null;
      if (sub) current[sub] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (current && kv) (sub ? current[sub] : current)[kv[1]!] = value(kv[2]!);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, normalize({ ...v, disabled: v.enabled === false })]).filter(([, v]) => v)) as Record<string, McpServerConfig>;
}

/** Every MCP server set up in the other tools on this machine (and in this project), first source wins per name. */
export function findOtherMcpServers(home = os.homedir(), cwd = process.cwd()): FoundServer[] {
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const claudeDesktop = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32" ? path.join(appData, "Claude", "claude_desktop_config.json") : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const claudeCode = json(path.join(home, ".claude.json"));
  const sources: { from: string; servers: Record<string, any> | undefined }[] = [
    { from: "Claude Code", servers: claudeCode?.mcpServers },
    { from: "Claude Code (this project)", servers: claudeCode?.projects?.[cwd]?.mcpServers },
    { from: "Claude Desktop", servers: json(claudeDesktop)?.mcpServers },
    { from: "Cursor", servers: json(path.join(home, ".cursor", "mcp.json"))?.mcpServers },
    { from: "Cursor (this project)", servers: json(path.join(cwd, ".cursor", "mcp.json"))?.mcpServers },
    { from: "Windsurf", servers: json(path.join(home, ".codeium", "windsurf", "mcp_config.json"))?.mcpServers },
    { from: "VS Code (this project)", servers: json(path.join(cwd, ".vscode", "mcp.json"))?.servers },
    { from: "Gemini CLI", servers: json(path.join(home, ".gemini", "settings.json"))?.mcpServers },
  ];
  try {
    sources.push({ from: "Codex", servers: codexServers(readFileSync(path.join(home, ".codex", "config.toml"), "utf-8")) });
  } catch {
    // no Codex config
  }
  const found: FoundServer[] = [];
  for (const { from, servers } of sources) {
    if (!servers || typeof servers !== "object") continue;
    for (const [name, raw] of Object.entries(servers)) {
      const config = normalize(raw);
      if (config && !found.some((f) => f.name === name)) found.push({ name, config, from });
    }
  }
  return found;
}
