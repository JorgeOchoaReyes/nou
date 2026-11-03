import type { RenderOptions } from "ink";

/** How Nou renders to the terminal (shared by the app and the rendering benchmark). */
export const RENDER_OPTIONS: RenderOptions = {
  alternateScreen: true,
  // Ctrl+C is handled inside the app: press it twice to quit, so a stray press doesn't lose work.
  exitOnCtrlC: false,
  // Rewrite only the lines that changed, not the whole screen: far less to send to the terminal per
  // keystroke or scroll, which matters most over SSH and in slower terminals (e.g. on Windows).
  incrementalRendering: true,
  // Up to 60 frames a second, so scrolling and typing keep up with the keyboard and mouse.
  maxFps: 60,
  // Library output goes to ~/.nou/nou.log instead (see cli.ts): Ink's console patch would print it into
  // the full-screen app, scrolling it so clicks land a row off.
  patchConsole: false,
  // Terminals that speak the kitty keyboard protocol (kitty, Ghostty, WezTerm, iTerm2, foot...) then tell
  // Enter from Ctrl+Enter, Cmd+Enter and Shift+Enter, so those can add a line in the chat. Others just
  // don't answer the query and keys work as before.
  kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
};
