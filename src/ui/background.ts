import type { Palette } from "./theme.js";

/** What Nou asks the terminal before it draws: its background, and whether it speaks the kitty keyboard protocol. */
export type TerminalInfo = {
  palette: Palette | null;
  /** true: it answered the kitty keyboard query; false: it answered others but not that; null: it answered nothing. */
  kitty: boolean | null;
};

/**
 * Asks the terminal, once, before Nou draws anything:
 * - its background color (OSC 11), so the colors are readable on it (COLORFGBG answers that without asking);
 * - whether it speaks the kitty keyboard protocol (CSI ? u), which tells Shift/Ctrl/Cmd+Enter, Cmd+F and
 *   Ctrl+= apart from plain keys. Ink can ask too, but only after the first frame is drawn, and with a big
 *   project the answer lands after its 200 ms timeout, so the protocol never came on (Shift+Enter sent).
 * Then DA1 (CSI c), which every terminal answers, and in order: once its answer is in, so are the others.
 */
export async function detectTerminal(timeoutMs = 400): Promise<TerminalInfo> {
  const fromEnv = paletteFromColorFgBg(process.env.COLORFGBG);
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") return { palette: fromEnv, kitty: null };
  return new Promise((resolve) => {
    let reply = "";
    const wasRaw = stdin.isRaw;
    const finish = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(readTerminalReply(reply, fromEnv));
    };
    const onData = (data: Buffer) => {
      reply += data.toString("latin1");
      if (DA1.test(reply)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    // OSC 11 is ST-terminated (ESC \): the form most terminals answer in kind.
    process.stdout.write(`${fromEnv ? "" : "\x1b]11;?\x1b\\"}\x1b[?u\x1b[c`);
  });
}

// eslint-disable-next-line no-control-regex -- terminal answers start with ESC
const KITTY = /\x1b\[\?\d+u/;
// eslint-disable-next-line no-control-regex -- terminal answers start with ESC
const DA1 = /\x1b\[\?[\d;]*c/;

/** What the terminal's answers say (see detectTerminal); `fromEnv` is the background COLORFGBG gave, if any. */
export function readTerminalReply(reply: string, fromEnv: Palette | null = null): TerminalInfo {
  return { palette: fromEnv ?? paletteFromOsc11(reply), kitty: KITTY.test(reply) ? true : DA1.test(reply) ? false : null };
}

/** Just the background (see detectTerminal). */
export async function detectBackground(timeoutMs = 400): Promise<Palette | null> {
  return (await detectTerminal(timeoutMs)).palette;
}

/** "15;0" (light text on black) → dark; "0;15" → light. The last number is the background's color index. */
export function paletteFromColorFgBg(value: string | undefined): Palette | null {
  const bg = Number(value?.split(";").at(-1));
  if (!value || !Number.isInteger(bg)) return null;
  // 7 (light gray) and 9-15 (bright colors, white) are light backgrounds; 0-6 and 8 are dark.
  return bg === 7 || (bg >= 9 && bg <= 15) ? "light" : "dark";
}

/** The terminal's answer to OSC 11: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (1-4 hex digits a channel), then BEL or ESC \. */
export function paletteFromOsc11(reply: string): Palette | null {
  // eslint-disable-next-line no-control-regex -- the reply starts with ESC
  const m = reply.match(/\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i);
  if (!m) return null;
  const channel = (hex: string) => parseInt(hex, 16) / (16 ** hex.length - 1);
  const [r, g, b] = [channel(m[1]!), channel(m[2]!), channel(m[3]!)];
  // Perceived brightness (Rec. 709 weights); above half is a light background.
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.5 ? "light" : "dark";
}
