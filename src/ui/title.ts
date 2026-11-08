/**
 * The terminal's window or tab title. Windows Terminal, iTerm2, Ghostty and the rest show the running shell
 * ("Windows PowerShell") unless the program sets its own with OSC 0, which Nou does: "Nou CLI".
 * The title before is saved (CSI 22;0t) and put back (CSI 23;0t) on the way out, in terminals that keep a
 * title stack (xterm, kitty, Ghostty, WezTerm, iTerm2); the others ignore those codes, and the shell retitles
 * its tab soon after.
 */
export const TITLE = "Nou CLI";

let set = false;

export function setTerminalTitle(title = TITLE): void {
  if (set || !process.stdout.isTTY) return;
  set = true;
  process.stdout.write(`\x1b[22;0t\x1b]0;${title}\x07`);
  process.on("exit", () => process.stdout.write("\x1b[23;0t"));
}
