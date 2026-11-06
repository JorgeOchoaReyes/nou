import { randomBytes } from "crypto";
import { existsSync, statSync } from "fs";
import net from "net";
import os from "os";
import path from "path";
import { loadPackage } from "../engines/index.js";
import { lineReader, tabName, type FromHost, type ToHost, type WorkspaceTab } from "./client.js";

/** The pseudo-terminal package workspaces run in, installed on first use into ~/.nou/engines like an engine. */
export const PTY_PACKAGE = "@lydell/node-pty";

type Pty = {
  onData(fn: (data: string) => void): void;
  onExit(fn: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

type Workspace = { id: string; folder: string; pty: Pty; busy: boolean; socket: net.Socket | null };

/** A folder for a new workspace: `~` and relative paths (from `from`) resolved; null when it isn't a folder. */
export function workspaceFolder(folder: string, from: string): string | null {
  const raw = folder.trim().replace(/^["']|["']$/g, "") || from;
  const full = path.resolve(from, raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
  try {
    return existsSync(full) && statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/**
 * Runs the workspaces window: each folder becomes a workspace, a whole Nou in its own pseudo-terminal. Only
 * the active one is drawn; the others keep working (their agents too) and draw everything again when you
 * switch to them. `firstArgs` go to the first workspace (e.g. --continue, to pick its conversation back up).
 * Resolves with the exit code once the last workspace is closed.
 */
export async function runHost(folders: string[], firstArgs: string[], command = [process.execPath, process.argv[1]!]): Promise<number> {
  const mod = await loadPackage(PTY_PACKAGE);
  const spawnPty: (file: string, args: string[], options: object) => Pty = mod.spawn ?? mod.default?.spawn;
  const token = randomBytes(16).toString("hex");
  const workspaces: Workspace[] = [];
  let active: Workspace | null = null;
  let nextId = 1;
  const size = () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 });

  const send = (w: Workspace, msg: FromHost) => w.socket?.write(`${JSON.stringify(msg)}\n`);
  const tabs = (): WorkspaceTab[] => workspaces.map((w) => ({ id: w.id, name: tabName(w.folder), folder: w.folder, busy: w.busy, active: w === active }));
  const broadcast = () => {
    const list = tabs();
    for (const w of workspaces) send(w, { type: "tabs", tabs: list });
  };
  const activate = (w: Workspace) => {
    active = w;
    broadcast();
    send(w, { type: "redraw" });
  };

  const server = net.createServer((socket) => {
    socket.on("data", lineReader((msg: ToHost) => {
      const from = workspaces.find((w) => w.socket === socket);
      if (msg.type === "hello") {
        const w = workspaces.find((x) => x.id === msg.id);
        if (!w || msg.token !== token) return socket.destroy(); // only our own workspaces
        w.socket = socket;
        send(w, { type: "tabs", tabs: tabs() });
        if (w === active) send(w, { type: "redraw" });
        return;
      }
      if (!from) return;
      if (msg.type === "state") {
        from.busy = msg.busy;
        broadcast();
      } else if (msg.type === "switch") {
        const to = workspaces[msg.index];
        if (to && to !== active) activate(to);
      } else if (msg.type === "new") {
        const folder = workspaceFolder(msg.folder, from.folder);
        if (!folder) return send(from, { type: "error", text: `No such folder: ${msg.folder}` });
        activate(open(folder, []));
      }
    }));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (finish = resolve));

  function open(folder: string, args: string[]): Workspace {
    const id = String(nextId++);
    const { cols, rows } = size();
    const pty = spawnPty(command[0]!, [...command.slice(1), ...args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: folder,
      env: { ...process.env, NOU_HOST_PORT: String(port), NOU_HOST_TOKEN: token, NOU_WORKSPACE_ID: id },
    });
    const w: Workspace = { id, folder, pty, busy: false, socket: null };
    workspaces.push(w);
    pty.onData((data) => {
      if (w === active) process.stdout.write(data);
    });
    pty.onExit(({ exitCode }) => {
      const at = workspaces.indexOf(w);
      if (at >= 0) workspaces.splice(at, 1);
      w.socket?.destroy();
      if (!workspaces.length) return finish(exitCode);
      if (w === active) activate(workspaces[Math.min(at, workspaces.length - 1)]!);
      else broadcast();
    });
    return w;
  }

  // Keys and mouse go to the workspace on screen; a resize goes to all of them.
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onInput = (data: Buffer) => active?.pty.write(data.toString("utf-8"));
  stdin.on("data", onInput);
  const onResize = () => {
    const { cols, rows } = size();
    for (const w of workspaces) w.pty.resize(cols, rows);
  };
  process.stdout.on("resize", onResize);
  const killAll = () => {
    for (const w of workspaces) w.pty.kill();
  };
  process.on("exit", killAll);

  folders.forEach((folder, i) => open(folder, i === 0 ? firstArgs : []));
  active = workspaces[workspaces.length - 1] ?? null; // the one just opened is the one you asked for
  broadcast();

  const code = await done;
  stdin.off("data", onInput);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  process.stdout.off("resize", onResize);
  process.off("exit", killAll);
  server.close();
  return code;
}
