import type { ExtraTool } from "../agent/index.js";
import type { ModelChoice } from "../providers/index.js";

export const ENGINE_IDS = ["nou", "claude-code", "codex", "pi"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export type EngineOptions = {
  /** Nou's full system prompt (its own agent uses it). */
  system?: string;
  /** Project context Nou adds on top (NOU.md, git summary, plugin instructions), for engines with their own prompt. */
  extras?: string[];
  extraTools?: ExtraTool[];
  effort?: string;
};

/**
 * The agent loop that answers chat messages. Nou's own Agent is one; Claude Code, Codex and pi are others.
 * Every engine reports through the same AgentHooks, so approvals, diffs, undo and problems work the same.
 */
export interface Engine {
  readonly id: EngineId;
  /** Distinguishes this conversation from earlier ones in the undo history. */
  readonly session: string;
  /** "<session>:<turn>", tagging each change so a whole turn can be rewound. */
  readonly turnId: string;
  choice: ModelChoice;
  configure(options: EngineOptions): void;
  setModel(choice: ModelChoice): void;
  clear(): void;
  /** Takes back the last message you sent and everything after it (engines that keep their own history leave this out). */
  retractLast?(): boolean;
  /** Something the model should know before the next message (e.g. the user undid its edit). */
  note(text: string): void;
  cancel(): void;
  /** Shrinks the conversation to free context (engines that manage their own context leave this out). */
  compact?(force?: boolean): Promise<boolean>;
  /** `context` (what the user is looking at) is sent to the model but not shown in the chat. */
  send(text: string, context?: string): Promise<void>;
  /** What it needs to pick this conversation back up later (/resume); engines that can't leave it out. */
  snapshot?(): unknown;
  /** Picks a saved conversation back up; false when it couldn't (Nou then hands it the transcript). */
  restore?(state: unknown): boolean;
  /** Frees processes and connections when switching to another engine. */
  dispose?(): void;
}

export type EngineInfo = {
  id: EngineId;
  label: string;
  description: string;
  /** npm package that provides it, installed on first use into ~/.nou/engines. Nou's own engine has none. */
  package?: string;
  /** Whether Nou can show you each edit and command before it happens, or only after. */
  approvals: "before" | "after";
  /** The model it will run, given the model picked in Nou (engines tied to one vendor use their own default otherwise). */
  model(choice: ModelChoice): string;
};
