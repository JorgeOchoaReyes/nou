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

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", args: "[provider:model]", description: "show or switch the model" },
  { name: "models", args: "[provider]", description: "list the models a provider offers" },
  { name: "connect", args: "<provider>", description: "enter an API key (and URL) for a provider" },
  { name: "open", args: "<file>[:line]", description: "open a file in the code view (part of its name is enough)" },
  { name: "settings", description: "models, engine, preferences and plugins" },
  { name: "auto", args: "[ask|auto-edit|auto]", description: "how much Nou does without asking" },
  { name: "engine", args: "[name]", description: "which agent answers: nou, claude-code, codex or pi" },
  { name: "undo", description: "undo Nou's last change" },
  { name: "rewind", description: "undo everything from Nou's last turn" },
  { name: "diff", args: "[file|n]", description: "everything changed this session (or session n)" },
  { name: "sessions", description: "earlier sessions with changes" },
  { name: "history", description: "recent changes, yours and Nou's" },
  { name: "problems", description: "every error and warning in the project" },
  { name: "copy", args: "[code|file]", description: "copy the last reply, its last code block, or the open file" },
  { name: "compact", description: "summarize the conversation to free up context" },
  { name: "clear", description: "start a fresh conversation" },
  { name: "pull", args: "<model>", description: "download an Ollama model" },
  { name: "plugins", args: "[add|new <name>]", description: "your plugins and the starter ones" },
  { name: "games", description: "open or close the Games panel (Pong, Snake, Breakout)" },
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
