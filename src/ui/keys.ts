/**
 * Find is shown as Ctrl+F everywhere (it works in every terminal). On a Mac, Cmd+F works too where the
 * terminal reports Cmd (the kitty keyboard protocol, which Nou asks for: Ghostty, kitty, WezTerm, iTerm2).
 */
export const FIND_KEY = "Ctrl+F";

/** Ctrl+F, or Cmd+F where the terminal reports Cmd. */
export const isFind = (input: string, key: { ctrl?: boolean; super?: boolean; shift?: boolean }) => input === "f" && (!!key.ctrl || !!key.super) && !key.shift;
/**
 * Ctrl+Shift+F (Cmd+Shift+F on a Mac): search every file, as in VS Code. Terminals report Shift with Ctrl only
 * with the kitty keyboard protocol; elsewhere it arrives as Ctrl+F, so /search is the way in everywhere.
 */
export const isSearchAll = (input: string, key: { ctrl?: boolean; super?: boolean; shift?: boolean }) => (input === "f" || input === "F") && (!!key.ctrl || !!key.super) && !!key.shift;
