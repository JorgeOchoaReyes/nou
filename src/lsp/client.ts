import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

export const toUri = (file: string) => pathToFileURL(path.resolve(process.cwd(), file)).href;

/** file:// URI -> path relative to the project, with forward slashes. */
export function fromUri(uri: string): string {
  try {
    return path.relative(process.cwd(), fileURLToPath(uri)).replace(/\\/g, "/");
  } catch {
    return uri;
  }
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** A minimal Language Server Protocol client over stdio (JSON-RPC with Content-Length framing). */
export class LspClient {
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: any) => void>();
  private versions = new Map<string, number>();
  private texts = new Map<string, string>();
  ready: Promise<void>;
  dead = false;
  /** Why the server stopped, if it did (shown in settings). */
  error: string | null = null;

  constructor(public name: string, command: string, args: string[], languageIds: Record<string, string>) {
    // npm-installed servers are .cmd shims on Windows, which need a shell. The command line is ours, not user text.
    const shell = process.platform === "win32" && !/\.exe$/i.test(command);
    // With a shell, quote the path so folders with spaces (C:\Program Files\...) work.
    this.child = spawn(shell ? `"${command}"` : command, args, { cwd: process.cwd(), shell, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.child.on("exit", () => this.fail(new Error(`${name} exited`)));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.languageIds = languageIds;

    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(process.cwd()).href,
      workspaceFolders: [{ uri: pathToFileURL(process.cwd()).href, name: path.basename(process.cwd()) }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: { linkSupport: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    }, 30_000).then(() => this.notify("initialized", {}));
    // A server that can't start shouldn't take Nou down; mark it dead and stop it.
    this.ready.catch((error: Error) => {
      this.error = error.message;
      this.fail(error);
      this.child.kill();
    });

    // Servers ask for settings; answering with nulls means "use your defaults".
    this.onRequest("workspace/configuration", (params) => (params?.items ?? []).map(() => null));
    this.onRequest("client/registerCapability", () => null);
    this.onRequest("window/workDoneProgress/create", () => null);
  }

  private languageIds: Record<string, string>;
  private requestHandlers = new Map<string, (params: any) => any>();

  private onRequest(method: string, handler: (params: any) => any) {
    this.requestHandlers.set(method, handler);
  }

  on(method: string, handler: (params: any) => void) {
    this.handlers.set(method, handler);
  }

  private fail(error: Error) {
    if (this.dead) return;
    this.dead = true;
    this.error ??= error.message;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private send(message: object) {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf-8");
    this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin!.write(body);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
      if (!length || this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf-8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // ignore malformed messages
      }
    }
  }

  private dispatch(message: any) {
    if (message.id !== undefined && message.method) {
      // A request from the server.
      const handler = this.requestHandlers.get(message.method);
      this.send({ id: message.id, result: handler ? handler(message.params) : null });
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method) {
      this.handlers.get(message.method)?.(message.params);
    }
  }

  request(method: string, params: unknown, timeout = 15_000): Promise<any> {
    if (this.dead) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  /** Opens or updates a document with the given (possibly unsaved) text. */
  async sync(file: string, text: string) {
    await this.ready;
    const uri = toUri(file);
    if (this.texts.get(uri) === text) return;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (!this.texts.has(uri)) {
      const languageId = this.languageIds[path.extname(file).toLowerCase()] ?? "plaintext";
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    } else {
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.texts.set(uri, text);
  }

  stop() {
    if (this.dead) return;
    this.request("shutdown", null, 2000).then(() => this.notify("exit", null)).catch(() => {}).finally(() => this.child.kill());
    this.dead = true;
  }
}
