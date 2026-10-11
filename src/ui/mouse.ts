import { useEffect, useRef } from "react";
import { useStdin } from "ink";

/** Positions are 0-based terminal cells. `dir` is -1 for wheel up, 1 for wheel down. */
export type MouseEvent =
  | { kind: "wheel"; dir: -1 | 1; x: number; y: number }
  | { kind: "click"; x: number; y: number };

// Report clicks and wheel (1000) using SGR coordinates (1006), which work past column 223.
const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1000l\x1b[?1006l";

/** Mouse events in a chunk of terminal input (SGR format: ESC [ < button ; x ; y M|m). */
export function parseMouse(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  // eslint-disable-next-line no-control-regex -- mouse reports start with ESC
  for (const m of chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const code = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    const button = code & 0b11000011; // drop the shift/alt/ctrl bits
    if (button === 64 || button === 65) events.push({ kind: "wheel", dir: button === 64 ? -1 : 1, x, y });
    else if (button === 0 && m[4] === "M") events.push({ kind: "click", x, y });
  }
  return events;
}

let exitHookInstalled = false;

/**
 * Turns on mouse reporting while mounted and calls `handler` for wheel and click events.
 * Ink keeps reading the keyboard as usual: a 'data' listener sees the same chunks Ink reads, and Ink
 * already ignores mouse sequences, so they never show up as typed text.
 */
export function useMouse(handler: (event: MouseEvent) => void, enabled: boolean) {
  const { stdin } = useStdin();
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled || !stdin) return;
    const terminal = process.stdout.isTTY ? process.stdout : null;
    terminal?.write(ENABLE);
    if (terminal && !exitHookInstalled) {
      // Leave the terminal clean even if Nou crashes; otherwise the shell gets mouse garbage.
      process.on("exit", () => process.stdout.write(DISABLE));
      exitHookInstalled = true;
    }
    const onData = (data: Buffer | string) => {
      for (const event of parseMouse(String(data))) latest.current(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      terminal?.write(DISABLE);
    };
  }, [enabled, stdin]);
}
