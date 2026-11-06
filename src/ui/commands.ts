/**
 * Every slash command, with what it does: the one list the chat's command menu, the command palette
 * and /help all read from, so none of them goes stale when a command is added.
 */
export type SlashCommand = {
  /** Without the slash, e.g. "model". */
  name: string;
  /** What it takes after the name, e.g. "[provider:model]"; empty when nothing. */
  args?: string;
  description: string;
};

/**
 * Commands that only change what's on screen (or handle a busy Nou themselves): they run right away
 * while Nou works instead of waiting in the queue behind it.
 */
const INSTANT = new Set(["now", "fold", "unfold", "redraw", "new", "tab", "close", "terminal", "games", "open", "settings", "auto", "diff", "sessions", "history", "problems", "copy", "help", "version", "cancel"]);

/** Whether a typed command runs right away while Nou works (see INSTANT); `/showme` counts only to look or step. */
/**
 * The command a mistyped name means: the same letters in another order ("/termnial"), or one letter off
 * ("/termial", "/terminall"). Only when exactly one command fits, so a typo never runs the wrong one.
 */
export function closestCommand(name: string, names: string[]): string | null {
  const word = name.toLowerCase();
  if (word.length < 3) return null;
  const sorted = (s: string) => [...s].sort().join("");
  const anagrams = names.filter((n) => n.length === word.length && sorted(n) === sorted(word));
  if (anagrams.length === 1) return anagrams[0]!;
  if (anagrams.length > 1) return null;
  const near = names.filter((n) => editDistance(word, n) <= 1);
  return near.length === 1 ? near[0]! : null;
}

/** Levenshtein distance, stopping early once it's over 1 (all closestCommand needs). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > 1) return 2;
    prev = row;
  }
  return prev[b.length]!;
}

export function runsWhileBusy(text: string): boolean {
  const [name, ...rest] = text.slice(1).trim().split(/\s+/);
  if (name === "showme" || name === "teach" || name === "teachme") return !rest.length || /^(next|skip|back|prev|previous|stop|end|done)$/.test(rest.join(" "));
  if (!text.startsWith("/") || !name) return false;
  return INSTANT.has(name) || INSTANT.has(closestCommand(name, SLASH_COMMANDS.map((c) => c.name)) ?? "");
}

/** Whether a command only changes what's on screen, so running it for a typo can't do harm. */
export const onlyChangesScreen = (name: string) => INSTANT.has(name);

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", args: "[provider:model]", description: "show or switch the model" },
  { name: "models", args: "[provider]", description: "list the models a provider offers" },
  { name: "connect", args: "<provider>", description: "enter an API key (and URL) for a provider" },
  { name: "open", args: "<file>[:line]", description: "open a file in the code view (part of its name is enough)" },
  { name: "effort", args: "[fastest|fast|balanced|smarter|smartest]", description: "speed vs smarts: how hard the model thinks (cheaper + faster, or smarter)" },
  { name: "now", description: "stop Nou and send your queued messages right away (or click them)" },
  { name: "settings", description: "models, engine, preferences and plugins" },
  { name: "auto", args: "[ask|auto-edit|auto]", description: "how much Nou does without asking" },
  { name: "engine", args: "[name]", description: "which agent answers: nou, claude-code, codex or pi" },
  { name: "cancel", description: "take back your last message (stops Nou; edit it and resend)" },
  { name: "undo", description: "undo Nou's last change" },
  { name: "rewind", description: "undo everything from Nou's last turn" },
  { name: "diff", args: "[file|n]", description: "everything changed this session (or session n)" },
  { name: "sessions", description: "earlier sessions with changes" },
  { name: "history", description: "recent changes, yours and Nou's" },
  { name: "problems", description: "every error and warning in the project" },
  { name: "copy", args: "[code|file]", description: "copy the last reply, its last code block, or the open file" },
  { name: "compact", description: "summarize the conversation to free up context" },
  { name: "clear", description: "start a fresh conversation" },
  { name: "showme", args: "<question>", description: "Nou explains it and opens the places in the code, highlighted (next/back step through them); any engine" },
  { name: "teach", args: "<what you want>", description: "Nou walks you through making the change yourself, step by step, with the code shown ahead of your cursor" },
  { name: "new", description: "a new conversation tab: another agent, working alongside this one" },
  { name: "tab", args: "[n]", description: "list the conversation tabs, or switch to tab n" },
  { name: "close", description: "close this conversation tab (it stays saved for /resume)" },
  { name: "fold", description: "fold every function and block in the open file to its first line (z toggles)" },
  { name: "unfold", description: "open every fold in the open file" },
  { name: "redraw", description: "draw the whole screen again (Ctrl+L), if it ever looks shifted or clicks land a row off" },
  { name: "terminal", description: "a terminal under the code, like VS Code's (or press `)" },
  { name: "resume", args: "[number|last]", description: "pick up an earlier conversation in this folder (any engine)" },
  { name: "pull", args: "<model>", description: "download an Ollama model" },
  { name: "plugins", args: "[add|new <name>]", description: "your plugins and the starter ones" },
  { name: "mcp", args: "[add|remove|import]", description: "MCP servers: tools from other programs (/mcp add browser for a browser)" },
  { name: "games", description: "open or close the Games panel (Pong, Snake, Breakout, Dodge, Hop, Pairs)" },
  { name: "version", description: "which version of Nou this is" },
  { name: "help", description: "all commands and keys" },
];

/** Commands whose name starts with what's typed after the slash (exact match first), plus plugin commands. */
export function matchCommands(typed: string, extra: SlashCommand[] = []): SlashCommand[] {
  const query = typed.replace(/^\//, "").toLowerCase();
  const all = [...SLASH_COMMANDS, ...extra];
  const starts = all.filter((c) => c.name.startsWith(query));
  // Then ones that merely contain it, so "/conn" and "/key"-style guesses still find something.
  const contains = query ? all.filter((c) => !c.name.startsWith(query) && (c.name.includes(query) || c.description.includes(query))) : [];
  return [...starts.sort((a, b) => Number(b.name === query) - Number(a.name === query)), ...contains];
}
