import { useEffect, useSyncExternalStore } from "react";
import { useStdin } from "ink";

/**
 * Whether Nou's terminal window is the one in front. Terminals that report focus (xterm's mode 1004:
 * iTerm2, Terminal.app, kitty, Ghostty, WezTerm, Windows Terminal, VS Code's, tmux with focus-events on)
 * send ESC [ I and ESC [ O as you switch windows; Nou then stops its spinners and git polling while you're
 * elsewhere, so it doesn't keep the CPU (and the terminal's redraws) busy for something nobody is watching.
 * Terminals that don't report it never send either, and Nou stays "focused" as before.
 */
let focused = true;
const listeners = new Set<() => void>();

export function setTerminalFocused(next: boolean) {
  if (next === focused) return;
  focused = next;
  for (const listener of listeners) listener();
}

export const terminalFocused = () => focused;

export function onTerminalFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalFocused(): boolean {
  return useSyncExternalStore(onTerminalFocus, terminalFocused, terminalFocused);
}

/** The last focus report in a chunk of terminal input, if there is one. Ink ignores these, so they're never typed. */
export function parseFocus(chunk: string): boolean | null {
  const at = Math.max(chunk.lastIndexOf("\x1b[I"), chunk.lastIndexOf("\x1b[O"));
  return at < 0 ? null : chunk[at + 2] === "I";
}

const ENABLE = "\x1b[?1004h";
const DISABLE = "\x1b[?1004l";
let exitHookInstalled = false;

/** Asks the terminal to report focus while mounted, and keeps `useTerminalFocused` up to date. */
export function useFocusReporting(enabled: boolean) {
  const { stdin } = useStdin();
  useEffect(() => {
    if (!enabled || !stdin) return;
    const terminal = process.stdout.isTTY ? process.stdout : null;
    terminal?.write(ENABLE);
    if (terminal && !exitHookInstalled) {
      process.on("exit", () => process.stdout.write(DISABLE));
      exitHookInstalled = true;
    }
    const onData = (data: Buffer | string) => {
      const next = parseFocus(String(data));
      if (next !== null) setTerminalFocused(next);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      terminal?.write(DISABLE);
      setTerminalFocused(true);
    };
  }, [enabled, stdin]);
}
