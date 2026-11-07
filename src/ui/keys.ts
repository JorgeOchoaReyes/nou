/**
 * Find is shown as Ctrl+F everywhere (it works in every terminal). On a Mac, Cmd+F works too where the
 * terminal reports Cmd (the kitty keyboard protocol, which Nou asks for: Ghostty, kitty, WezTerm, iTerm2).
 */
export const FIND_KEY = "Ctrl+F";

/** Ctrl+F, or Cmd+F where the terminal reports Cmd. */
export const isFind = (input: string, key: { ctrl?: boolean; super?: boolean }) => input === "f" && (!!key.ctrl || !!key.super);
