import { useEffect, useRef } from "react";
import { useStdin } from "ink";

/**
 * Positions are 0-based terminal cells. `dir` is -1 for wheel up (or left), 1 for down (or right);
 * `horizontal` for a tilt wheel or Shift+wheel.
 */
export type MouseEvent =
  | { kind: "wheel"; dir: -1 | 1; x: number; y: number; horizontal: boolean }
  /** `define`: Ctrl+click, Alt/Option+click or a right-click, which go to a definition. */
  | { kind: "click"; x: number; y: number; define?: boolean }
  | { kind: "drag"; x: number; y: number }
  | { kind: "release"; x: number; y: number };

// Report clicks and wheel (1000), and movement while a button is held (1002, without it terminals never
// send drags: no resizing panes, dragging scrollbars or selecting), using SGR coordinates (1006), which
// work past column 223.
export const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** Mouse events in a chunk of terminal input (SGR format: ESC [ < button ; x ; y M|m). */
export function parseMouse(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  // eslint-disable-next-line no-control-regex -- mouse reports start with ESC
  for (const m of chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const code = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    const button = code & 0b11000011; // drop the shift/alt/ctrl bits
    const shift = (code & 4) !== 0;
    const modified = (code & (8 | 16)) !== 0; // Alt (Option) or Ctrl
    if (button === 64 || button === 65) events.push({ kind: "wheel", dir: button === 64 ? -1 : 1, x, y, horizontal: shift });
    else if (button === 66 || button === 67) events.push({ kind: "wheel", dir: button === 66 ? -1 : 1, x, y, horizontal: true });
    else if (button === 0 && code & 32) events.push({ kind: "drag", x, y }); // 32: moved with the left button held
    else if (button === 0) events.push(m[4] === "M" ? { kind: "click", x, y, ...(modified ? { define: true } : {}) } : { kind: "release", x, y });
    else if (button === 2 && m[4] === "M") events.push({ kind: "click", x, y, define: true }); // right-click
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
