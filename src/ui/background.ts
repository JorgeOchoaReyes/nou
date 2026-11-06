import type { Palette } from "./theme.js";

/**
 * Whether the terminal's background is light or dark, so Nou can pick colors that are readable on it.
 *
 * COLORFGBG (set by rxvt, Konsole and others: "foreground;background" as color numbers) answers at once.
 * Otherwise Nou asks the terminal for its background color (OSC 11, answered by iTerm2, Terminal.app,
 * kitty, Ghostty, WezTerm, Alacritty, foot, GNOME's and VS Code's terminals and recent Windows Terminal).
 * A terminal that doesn't answer within `timeoutMs` gets null, and Nou keeps its dark colors.
 */
export async function detectBackground(timeoutMs = 150): Promise<Palette | null> {
  const fromEnv = paletteFromColorFgBg(process.env.COLORFGBG);
  if (fromEnv) return fromEnv;
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") return null;
  return new Promise((resolve) => {
    let reply = "";
    const wasRaw = stdin.isRaw;
    const finish = (result: Palette | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(result);
    };
    const onData = (data: Buffer) => {
      reply += data.toString("latin1");
      const palette = paletteFromOsc11(reply);
      if (palette) finish(palette);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    // ST-terminated (ESC \): the form most terminals answer in kind.
    process.stdout.write("\x1b]11;?\x1b\\");
  });
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
