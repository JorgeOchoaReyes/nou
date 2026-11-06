import net from "net";
import path from "path";
import { useSyncExternalStore } from "react";

/**
 * Workspaces: several Nous in one terminal window, one per tab in the header, each with its own folder,
 * files, chats and agents. A small host process owns the window and runs each workspace as its own Nou in a
 * pseudo-terminal, showing the active one (see host.ts). The two talk over a local socket: this is the
 * workspace's side.
 */
export type WorkspaceTab = { id: string; name: string; folder: string; busy: boolean; active: boolean };

/** Messages a workspace sends the host. */
export type ToHost =
  | { type: "hello"; id: string; token: string }
  | { type: "switch"; index: number }
  | { type: "new"; folder: string }
  | { type: "state"; busy: boolean };

/** Messages the host sends a workspace. */
export type FromHost =
  | { type: "tabs"; tabs: WorkspaceTab[] }
  /** You're on screen again: draw everything (the other workspace's picture is still there). */
  | { type: "redraw" }
  | { type: "error"; text: string };

let tabs: WorkspaceTab[] = [];
const listeners = new Set<() => void>();
let socket: net.Socket | null = null;

/** Whether this Nou is one workspace of several (run by the host). */
export const isHosted = () => !!process.env.NOU_HOST_PORT && !!process.env.NOU_WORKSPACE_ID;

export function workspaceTabs(): WorkspaceTab[] {
  return tabs;
}

export function useWorkspaceTabs(): WorkspaceTab[] {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, workspaceTabs, workspaceTabs);
}

/** One JSON message a line. */
export function lineReader(onMessage: (msg: any) => void): (chunk: Buffer | string) => void {
  let carry = "";
  return (chunk) => {
    carry += String(chunk);
    let at: number;
    while ((at = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, at);
      carry = carry.slice(at + 1);
      try {
        onMessage(JSON.parse(line));
      } catch {
        // not ours
      }
    }
  };
}

/** Connects to the host (when hosted) and passes on what it says. */
export function connectToHost(on: { redraw(): void; error(text: string): void }): void {
  if (!isHosted() || socket) return;
  const s = net.connect(Number(process.env.NOU_HOST_PORT), "127.0.0.1");
  s.unref(); // never what keeps Nou running once you quit it
  socket = s;
  s.on("connect", () => sendToHost({ type: "hello", id: process.env.NOU_WORKSPACE_ID!, token: process.env.NOU_HOST_TOKEN ?? "" }));
  s.on("data", lineReader((msg: FromHost) => {
    if (msg.type === "tabs") {
      tabs = msg.tabs;
      for (const fn of listeners) fn();
    } else if (msg.type === "redraw") on.redraw();
    else if (msg.type === "error") on.error(msg.text);
  }));
  s.on("error", () => {});
  s.on("close", () => (socket = null));
}

export function sendToHost(msg: ToHost): boolean {
  if (!socket || socket.destroyed) return false;
  socket.write(`${JSON.stringify(msg)}\n`);
  return true;
}

/** What a tab is called: the folder's name. */
export const tabName = (folder: string) => path.basename(path.resolve(folder)) || folder;

/** Set when this Nou should reopen as a workspaces window as it quits (see cli.ts). */
let reopenAs: string[] | null = null;
export const reopenAsWorkspaces = (folders: string[]) => (reopenAs = folders);
export const pendingWorkspaces = () => reopenAs;
