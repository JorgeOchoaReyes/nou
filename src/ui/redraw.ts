/**
 * A full repaint: the app normally rewrites only the lines that changed, so if anything outside it ever
 * wrote to the terminal, the screen would stay shifted (clicks landing a row off) until something forces
 * every line out again. The CLI hands over Ink's clear here; /redraw and Ctrl+L call it.
 */
let clearScreen: (() => void) | null = null;

export function setScreenClear(fn: () => void) {
  clearScreen = fn;
}

/** Forgets what's on screen, so the next frame is drawn in full; false where there's no terminal (tests). */
export function forgetScreen(): boolean {
  if (!clearScreen) return false;
  clearScreen();
  return true;
}
