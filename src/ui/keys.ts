/**
 * Keys named the way the platform names them. On a Mac, Find is Cmd+F: terminals that report the Cmd key
 * (kitty's keyboard protocol, which Nou asks for: Ghostty, kitty, WezTerm, iTerm2) send it as "super". Ctrl+F
 * works everywhere too, for terminals that keep Cmd for themselves.
 */
export const FIND_KEY = process.platform === "darwin" ? "Cmd+F" : "Ctrl+F";

/** Ctrl+F, or Cmd+F where the terminal reports Cmd. */
export const isFind = (input: string, key: { ctrl?: boolean; super?: boolean }) => input === "f" && (!!key.ctrl || !!key.super);
