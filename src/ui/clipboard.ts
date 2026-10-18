import { spawn } from "child_process";

/** Native clipboard commands to try, in order, for this platform. */
function commands(): [string, string[]][] {
  if (process.platform === "win32") return [["powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]];
  if (process.platform === "darwin") return [["pbcopy", []]];
  return [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
}

function run(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

/**
 * Copies text to the system clipboard. Also sends it as an OSC 52 escape, which terminals that
 * support it (Windows Terminal, iTerm2, kitty, WezTerm...) put on the clipboard even over SSH.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  for (const [cmd, args] of commands()) if (await run(cmd, args, text)) return true;
  return process.stdout.isTTY === true;
}

/** Commands that print the clipboard, in order, for this platform. */
function readCommands(): [string, string[]][] {
  if (process.platform === "win32") return [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]];
  if (process.platform === "darwin") return [["pbpaste", []]];
  return [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]];
}

function capture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * The system clipboard's text, or null if no clipboard tool is available (e.g. over SSH; there the
 * terminal's own paste, Ctrl+Shift+V or Cmd+V, still works).
 */
export async function readClipboard(): Promise<string | null> {
  for (const [cmd, args] of readCommands()) {
    const text = await capture(cmd, args);
    if (text !== null) return process.platform === "win32" ? text.replace(/\r?\n$/, "") : text;
  }
  return null;
}
