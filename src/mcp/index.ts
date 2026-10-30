import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { NOU_HOME } from "../config/index.js";
import type { ExtraTool } from "../agent/index.js";

/**
 * MCP servers: tools from other programs (a browser, GitHub, a database...) that Nou's engine can use.
 * They're listed the way Claude Code, Claude Desktop and Cursor list them, so configs carry over as is:
 * { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...} } or { "url": "https://..." } } }
 */
export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
};
export type McpEntry = { name: string; config: McpServerConfig; scope: "user" | "project"; file: string };

export const USER_MCP_FILE = path.join(NOU_HOME, "mcp.json");
/** Project MCP files (only read in a folder you trust: they start programs). */
const PROJECT_MCP_FILES = [".mcp.json", path.join(".nou", "mcp.json")];

/** Ready-made servers: `/mcp add browser` and so on. */
export const MCP_PRESETS: Record<string, { config: McpServerConfig; about: string }> = {
  browser: { config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] }, about: "control a browser: open pages, click, type, read them, take screenshots (Playwright)" },
  fetch: { config: { command: "uvx", args: ["mcp-server-fetch"] }, about: "fetch web pages as text (needs uv)" },
};

function readServers(file: string): Record<string, McpServerConfig> {
  try {
    const json = JSON.parse(readFileSync(file, "utf-8"));
    const servers = json?.mcpServers ?? json?.servers ?? {};
    return typeof servers === "object" && servers ? servers : {};
  } catch {
    return {};
  }
}

/** Every configured server: yours (~/.nou/mcp.json) and, in a trusted folder, the project's. */
export function loadMcpServers(trusted: boolean): McpEntry[] {
  const out: McpEntry[] = [];
  for (const [name, config] of Object.entries(readServers(USER_MCP_FILE))) out.push({ name, config, scope: "user", file: USER_MCP_FILE });
  if (trusted) {
    for (const rel of PROJECT_MCP_FILES) {
      const file = path.resolve(rel);
      for (const [name, config] of Object.entries(readServers(file))) {
        if (!out.some((e) => e.name === name)) out.push({ name, config, scope: "project", file });
      }
    }
  }
  return out.filter((e) => e.config && (e.config.command || e.config.url));
}

/** Adds (or replaces) servers in ~/.nou/mcp.json. */
export function saveUserServers(servers: Record<string, McpServerConfig>) {
  let json: any = {};
  try {
    json = JSON.parse(readFileSync(USER_MCP_FILE, "utf-8"));
  } catch {
    // a new file
  }
  json.mcpServers = { ...(json.mcpServers ?? {}), ...servers };
  if (!existsSync(NOU_HOME)) mkdirSync(NOU_HOME, { recursive: true });
  writeFileSync(USER_MCP_FILE, JSON.stringify(json, null, 2), { mode: 0o600 });
  try {
    chmodSync(USER_MCP_FILE, 0o600); // it can hold tokens
  } catch {
    // Windows ignores it
  }
}

export function removeUserServer(name: string): boolean {
  try {
    const json = JSON.parse(readFileSync(USER_MCP_FILE, "utf-8"));
    if (!json.mcpServers?.[name]) return false;
    delete json.mcpServers[name];
    writeFileSync(USER_MCP_FILE, JSON.stringify(json, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

type McpTool = { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean } };
export type McpStatus = { name: string; scope: McpEntry["scope"]; state: "connecting" | "ready" | "failed" | "off"; tools: number; error?: string };

/** Tool names the model sees: mcp__server__tool, in the characters every provider accepts. */
const toolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** Keeps the end of a server's stderr, to say why it failed (it never reaches the screen). */
function tailOf(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer | string) => {
    text = (text + String(chunk)).slice(-2000);
  });
  return () => text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

/**
 * Connects to the MCP servers and turns their tools into tools for Nou's engine. A server's output goes to
 * a buffer, never the terminal, so it can't scribble over Nou's screen; tools that change things ask
 * first, like Nou's own.
 */
export class McpManager {
  private servers = new Map<string, { status: McpStatus; client?: any; transport?: any; tools: McpTool[] }>();

  constructor(private onChange: () => void) {}

  status(): McpStatus[] {
    return [...this.servers.values()].map((s) => s.status);
  }

  /** Connects to every enabled server in `entries` (already connected ones are kept). */
  async connect(entries: McpEntry[]) {
    const wanted = new Set(entries.map((e) => e.name));
    for (const [name, s] of this.servers) {
      if (!wanted.has(name)) {
        void s.client?.close().catch(() => {});
        this.servers.delete(name);
      }
    }
    await Promise.all(entries.filter((e) => !this.servers.has(e.name)).map((e) => this.start(e)));
  }

  private async start(entry: McpEntry) {
    const status: McpStatus = { name: entry.name, scope: entry.scope, state: entry.config.disabled ? "off" : "connecting", tools: 0 };
    const slot: { status: McpStatus; client?: any; transport?: any; tools: McpTool[] } = { status, tools: [] };
    this.servers.set(entry.name, slot);
    this.onChange();
    if (entry.config.disabled) return;
    let stderr = () => "";
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "nou", version: "1" });
      let transport: any;
      if (entry.config.url) {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        transport = new StreamableHTTPClientTransport(new URL(entry.config.url), entry.config.headers ? { requestInit: { headers: entry.config.headers } } : undefined);
      } else {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        transport = new StdioClientTransport({
          command: entry.config.command!,
          args: entry.config.args ?? [],
          // The SDK adds a safe base (PATH, HOME...) to these: your API keys aren't passed to every server.
          ...(entry.config.env ? { env: entry.config.env } : {}),
          cwd: entry.config.cwd ?? process.cwd(),
          stderr: "pipe",
        });
        stderr = tailOf(transport.stderr);
      }
      await withTimeout(client.connect(transport), 30_000, "didn't answer within 30 seconds");
      const { tools } = await withTimeout(client.listTools(), 15_000, "didn't list its tools");
      Object.assign(slot, { client, transport, tools });
      slot.status = { ...status, state: "ready", tools: tools.length };
    } catch (error: any) {
      const why = stderr();
      slot.status = { ...status, state: "failed", error: `${error?.message ?? error}${why ? ` (${why})` : ""}` };
    }
    this.onChange();
  }

  /** The connected servers' tools, ready for the engine. */
  tools(): ExtraTool[] {
    const out: ExtraTool[] = [];
    for (const [server, s] of this.servers) {
      if (s.status.state !== "ready") continue;
      for (const tool of s.tools) {
        const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
        out.push({
          definition: {
            name: toolName(server, tool.name),
            description: `[${server}] ${tool.description ?? tool.name}`.slice(0, 1000),
            parameters: { ...schema, type: "object", properties: schema.properties ?? {}, required: Array.isArray(schema.required) ? schema.required : [] },
          },
          // Only tools that say they don't change anything run without asking.
          readOnly: tool.annotations?.readOnlyHint === true,
          source: `mcp:${server}`,
          run: async (args) => {
            const result = await s.client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 180_000 });
            const parts = (result.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text ?? "" : `[${c.type}]`));
            const text = parts.join("\n").trim() || "(no output)";
            return result.isError ? `Error: ${text}` : text;
          },
        });
      }
    }
    return out;
  }

  close() {
    for (const s of this.servers.values()) void s.client?.close().catch(() => {});
    this.servers.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(why)), ms);
    promise.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(e)));
  });
}
