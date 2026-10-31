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
const INSTANT = new Set(["new", "tab", "close", "terminal", "games", "open", "settings", "auto", "diff", "sessions", "history", "problems", "copy", "help", "version", "cancel"]);

/** Whether a typed command runs right away while Nou works (see INSTANT); `/showme` counts only to look or step. */
export function runsWhileBusy(text: string): boolean {
  const [name, ...rest] = text.slice(1).trim().split(/\s+/);
  if (name === "showme" || name === "teach") return !rest.length || /^(next|skip|stop|end)$/.test(rest.join(" "));
  return text.startsWith("/") && INSTANT.has(name ?? "");
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", args: "[provider:model]", description: "show or switch the model" },
  { name: "models", args: "[provider]", description: "list the models a provider offers" },
  { name: "connect", args: "<provider>", description: "enter an API key (and URL) for a provider" },
  { name: "open", args: "<file>[:line]", description: "open a file in the code view (part of its name is enough)" },
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
  { name: "showme", args: "<what you want>", description: "Nou shows you how, step by step, and you type it (with the code shown ahead of your cursor)" },
  { name: "teach", args: "<what you want>", description: "same as /showme: Nou teaches you to make the change yourself, step by step" },
  { name: "new", description: "a new conversation tab: another agent, working alongside this one" },
  { name: "tab", args: "[n]", description: "list the conversation tabs, or switch to tab n" },
  { name: "close", description: "close this conversation tab (it stays saved for /resume)" },
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
