import { spawn, type ChildProcess } from "child_process";
import { existsSync, statSync } from "fs";
import os from "os";
import path from "path";
import { stripVTControlCharacters } from "util";
import { stopProcess } from "../commands/index.js";

/** Lines of output kept (the oldest go first). */
const KEEP = 3000;

export type ShellLine = { text: string; kind: "out" | "command" | "info" | "error" };

/**
 * The terminal panel's shell: runs what you type with your shell in the folder you've `cd`'d to, and
 * keeps the output. Each command is its own process (no native pseudo-terminal), so full-screen programs
 * like vim won't draw, but builds, tests, git and servers work, and what you type while one runs goes
 * to it.
 */
export class Shell {
  lines: ShellLine[] = [];
  cwd = process.cwd();
  private child: ChildProcess | null = null;
  /** The line being written (output without its newline yet; a \r starts it over, like progress bars). */
  private partial = "";

  constructor(private onChange: () => void) {
    process.once("exit", () => this.interrupt()); // nothing it started is left running after Nou
  }

  get running(): boolean {
    return !!this.child;
  }

  /** Runs a command line; `cd` and `clear` are handled here so they stick. */
  run(command: string) {
    const line = command.trim();
    if (!line) return;
    if (this.child) return this.input(command);
    this.push({ text: `${this.prompt()}${line}`, kind: "command" });
    if (line === "clear" || line === "cls") {
      this.lines = [];
      return this.onChange();
    }
    const cd = /^cd(?:\s+(.*))?$/.exec(line);
    if (cd) return this.changeDir(cd[1]?.trim().replace(/^["']|["']$/g, "") || os.homedir());

    const posix = process.platform !== "win32";
    const child = spawn(line, {
      cwd: this.cwd,
      shell: posix ? process.env.SHELL || true : true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: posix, // its own process group, so Ctrl+C stops everything it started
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    this.child = child;
    const write = (chunk: Buffer) => this.write(chunk.toString("utf-8"));
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.stdin?.on("error", () => {}); // it may exit before reading what you typed
    child.on("error", (error) => this.push({ text: error.message, kind: "error" }));
    child.on("close", (code, signal) => {
      this.flush();
      if (signal) this.push({ text: "stopped", kind: "info" });
      else if (code) this.push({ text: `exit ${code}`, kind: "error" });
      this.child = null;
      this.onChange();
    });
    this.onChange();
  }

  /** Text for the running command's input (it gets a newline, like pressing Enter in a terminal). */
  input(text: string) {
    if (!this.child?.stdin?.writable) return;
    this.push({ text, kind: "command" });
    this.child.stdin.write(`${text}\n`);
  }

  /** Ctrl+C: stops the running command. */
  interrupt() {
    if (this.child) stopProcess(this.child);
  }

  clear() {
    this.lines = [];
    this.partial = "";
    this.onChange();
  }

  dispose() {
    this.interrupt();
  }

  prompt(): string {
    const home = os.homedir();
    const where = this.cwd === home ? "~" : this.cwd.startsWith(home + path.sep) ? `~${this.cwd.slice(home.length)}` : this.cwd;
    return `${where.length > 30 ? `…${path.sep}${path.basename(where)}` : where} $ `;
  }

  private changeDir(target: string) {
    const next = path.resolve(this.cwd, target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target);
    if (!existsSync(next) || !statSync(next).isDirectory()) this.push({ text: `cd: no such folder: ${target}`, kind: "error" });
    else this.cwd = next;
    this.onChange();
  }

  private write(text: string) {
    const parts = stripVTControlCharacters(text).replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      // A carriage return goes back to the start of the line: what follows replaces it.
      this.partial = part.includes("\r") ? part.slice(part.lastIndexOf("\r") + 1) || this.partial : this.partial + part;
      if (i < parts.length - 1) this.flush(true);
    }
    this.onChange();
  }

  private flush(always = false) {
    if (this.partial || always) this.push({ text: this.partial.replace(/\t/g, "  "), kind: "out" });
    this.partial = "";
  }

  /** The output so far, with the line still being written. */
  view(): ShellLine[] {
    return this.partial ? [...this.lines, { text: this.partial, kind: "out" }] : this.lines;
  }

  private push(line: ShellLine) {
    this.lines.push(line);
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
  }
}
