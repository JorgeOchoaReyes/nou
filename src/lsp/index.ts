import { existsSync } from "fs";
import path from "path";
import type { Diagnostic, DiagnosticsProvider, Severity } from "../diagnostics/types.js";
import { LspClient, fromUri, toUri } from "./client.js";

export type ServerConfig = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** File extension -> LSP language id. */
  languages: Record<string, string>;
};

/** Servers Nou knows how to talk to. Each is used only if it's installed. Users can add more in settings. */
export const KNOWN_SERVERS: ServerConfig[] = [
  {
    id: "typescript", name: "TypeScript", command: "typescript-language-server", args: ["--stdio"],
    languages: { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" },
  },
  { id: "pyright", name: "Pyright", command: "pyright-langserver", args: ["--stdio"], languages: { ".py": "python", ".pyi": "python" } },
  { id: "rust-analyzer", name: "rust-analyzer", command: "rust-analyzer", args: [], languages: { ".rs": "rust" } },
  { id: "gopls", name: "gopls", command: "gopls", args: [], languages: { ".go": "go" } },
  { id: "clangd", name: "clangd", command: "clangd", args: [], languages: { ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp" } },
];

/** Finds a program on PATH (or in the project's node_modules/.bin), on Windows, macOS and Linux. */
export function findExecutable(command: string): string | null {
  const dirs = [path.join(process.cwd(), "node_modules", ".bin"), ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const SEVERITY: Record<number, Severity> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

/** Starts language servers on demand and exposes problems, hover and go-to-definition. */
export class LspManager {
  private clients = new Map<string, LspClient>();
  private failures = new Map<string, number>();
  /** Servers that failed to start, with the reason. */
  readonly broken = new Map<string, string>();
  /** file (normalized, project-relative) -> latest published problems. Servers format URIs differently (e.g. c%3A), so never key by raw URI. */
  private published = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, Array<() => void>>();

  constructor(private servers: ServerConfig[] = KNOWN_SERVERS) {}

  serverFor(file: string): ServerConfig | undefined {
    const ext = path.extname(file).toLowerCase();
    return this.servers.find((s) => s.languages[ext] && findExecutable(s.command));
  }

  /** Installed servers, for the settings screen. */
  installed(): ServerConfig[] {
    return this.servers.filter((s) => findExecutable(s.command));
  }

  private client(file: string): LspClient | null {
    const server = this.serverFor(file);
    if (!server) return null;
    const existing = this.clients.get(server.id);
    if (existing && !existing.dead) return existing;
    if (this.broken.has(server.id) || (this.failures.get(server.id) ?? 0) >= 3) return null; // stop retrying
    if (existing?.dead) this.failures.set(server.id, (this.failures.get(server.id) ?? 0) + 1);

    const client = new LspClient(server.name, findExecutable(server.command)!, server.args, server.languages);
    client.on("textDocument/publishDiagnostics", (params) => {
      const file = fromUri(params.uri);
      this.published.set(file.toLowerCase(), (params.diagnostics ?? []).map((d: any): Diagnostic => ({
        file,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endCol: d.range.end.character + 1,
        severity: SEVERITY[d.severity ?? 1] ?? "error",
        message: String(d.message).split("\n")[0]!,
        source: server.id,
        ...(d.code !== undefined ? { code: String(d.code) } : {}),
      })));
      for (const wake of this.waiters.get(file.toLowerCase()) ?? []) wake();
      this.waiters.delete(file.toLowerCase());
    });
    // If it can't even start (e.g. incompatible TypeScript version), give up on it for this session.
    client.ready.catch((error: Error) => this.broken.set(server.id, error.message.split(". ")[0]!));
    this.clients.set(server.id, client);
    return client;
  }

  /** Sends the text and waits for the server's problems (it publishes them asynchronously). */
  async diagnostics(file: string, text: string, timeout = 8000): Promise<Diagnostic[]> {
    const client = this.client(file);
    if (!client) return [];
    const key = fromUri(toUri(file)).toLowerCase();
    const published = new Promise<void>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
    });
    try {
      await client.sync(file, text);
    } catch {
      return [];
    }
    // Servers often publish twice (syntax, then semantic); wait for the first, then a short quiet period.
    await Promise.race([published, new Promise((r) => setTimeout(r, timeout))]);
    await new Promise((r) => setTimeout(r, 400));
    return this.published.get(key) ?? [];
  }

  async hover(file: string, text: string, line: number, col: number): Promise<string | null> {
    const client = this.client(file);
    if (!client) return null;
    if (!(await client.sync(file, text).then(() => true, () => false))) return null;
    const result = await client.request("textDocument/hover", { textDocument: { uri: toUri(file) }, position: { line: line - 1, character: col - 1 } }).catch(() => null);
    const contents = result?.contents;
    if (!contents) return null;
    const parts = Array.isArray(contents) ? contents : [contents];
    const textOut = parts.map((p: any) => (typeof p === "string" ? p : p.value ?? "")).join("\n");
    return textOut.replace(/```\w*\n?/g, "").trim() || null;
  }

  async definition(file: string, text: string, line: number, col: number): Promise<{ file: string; line: number; col: number } | null> {
    const client = this.client(file);
    if (!client) return null;
    if (!(await client.sync(file, text).then(() => true, () => false))) return null;
    const result = await client.request("textDocument/definition", { textDocument: { uri: toUri(file) }, position: { line: line - 1, character: col - 1 } }).catch(() => null);
    const first = Array.isArray(result) ? result[0] : result;
    if (!first?.uri && !first?.targetUri) return null;
    const uri = first.uri ?? first.targetUri;
    const range = first.range ?? first.targetSelectionRange ?? first.targetRange;
    return { file: fromUri(uri), line: range.start.line + 1, col: range.start.character + 1 };
  }

  stopAll() {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }

  /** Problems from language servers, through the same interface as linters. */
  provider(): DiagnosticsProvider {
    return {
      id: "lsp",
      name: "Language servers",
      checksText: true,
      matches: (file) => this.serverFor(file) !== undefined,
      available: () => this.installed().length > 0,
      check: (file, text) => this.diagnostics(file, text),
    };
  }
}

/** One set of language servers for the whole app. */
export const lsp = new LspManager();
