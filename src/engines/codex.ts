import { execFileSync } from "child_process";
import { statSync } from "fs";
import type { AgentHooks } from "../agent/index.js";
import type { ModelChoice } from "../providers/index.js";
import { listAllFiles } from "../ui/QuickOpen.js";
import { ExternalEngine } from "./external.js";
import { loadPackage } from "./index.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;

/** Project files small enough to keep a copy of (git's list when there is one, so ignored files are skipped). */
function projectFiles(): string[] {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean).slice(0, MAX_FILES);
  } catch {
    files = listAllFiles(MAX_FILES);
  }
  return files.filter((file) => {
    try {
      return statSync(file).size <= MAX_BYTES;
    } catch {
      return false;
    }
  });
}

/** Codex's errors, with what to do about the common one: not being signed in. */
function explain(message: string): string {
  const first = message.split("\n")[0]!;
  if (/401|Unauthorized|authentication|not logged in/i.test(message)) {
    return "Codex isn't signed in. Run `codex login` (or set OPENAI_API_KEY), then try again.";
  }
  return first;
}

/**
 * Codex through the Codex SDK. Codex has no per-edit approval hook: it works in its workspace sandbox, and
 * Nou keeps a copy of the project's files at the start of each message so every change it made can be
 * shown and undone afterwards.
 */
export class CodexEngine extends ExternalEngine {
  readonly id = "codex" as const;
  private thread: any = null;
  private introduced = false;

  constructor(choice: ModelChoice, hooks: AgentHooks) {
    super(choice, hooks, "Codex");
  }

  protected resetConversation() {
    this.thread = null;
    this.introduced = false;
  }

  protected async run(prompt: string, signal: AbortSignal) {
    const { Codex } = await loadPackage("@openai/codex-sdk");
    // Codex uses its own login (`codex login`); an OpenAI key from Nou's setup works too.
    const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
    this.thread ??= new Codex(apiKey ? { apiKey } : {}).startThread({
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      ...(this.choice.provider.id === "openai" ? { model: this.choice.model } : {}),
      ...(this.effort && EFFORTS.has(this.effort) ? { modelReasoningEffort: this.effort } : {}),
    });
    // Codex has no system prompt option; Nou's project context goes with the first message.
    const input = !this.introduced && this.extras.length ? `${this.extras.join("\n\n")}\n\n${prompt}` : prompt;
    this.introduced = true;
    this.tracker.remember(projectFiles());

    let failure: string | undefined;
    try {
      const { events } = await this.thread.runStreamed(input, { signal });
      for await (const event of events) failure = (await this.handle(event)) ?? failure;
    } catch (error: any) {
      // The codex process exiting with an error ends the stream; its first line says why.
      if (signal.aborted) throw error;
      failure ??= error.message;
    }
    if (signal.aborted) throw new Error("aborted");
    if (failure) throw new Error(explain(failure));
  }

  /** Shows one Codex event; returns the error message if the turn failed. */
  private async handle(event: any): Promise<string | undefined> {
    if (event.type === "item.updated" && event.item.type === "agent_message") {
      this.hooks.onStream(event.item.text);
    } else if (event.type === "item.started" && event.item.type === "command_execution") {
      this.hooks.onBusy(`Codex: ${event.item.command}`);
    } else if (event.type === "item.completed") {
      const item = event.item;
      if (item.type === "agent_message") {
        this.hooks.onStream("");
        if (item.text.trim()) this.hooks.onEntry({ kind: "assistant", text: item.text.trim() });
      } else if (item.type === "command_execution") {
        this.hooks.onEntry({ kind: "tool", text: `Ran: ${item.command}${item.exit_code ? ` (exit ${item.exit_code})` : ""}` });
        this.hooks.onBusy("Codex is working...");
      } else if (item.type === "file_change") {
        for (const change of item.changes) {
          if (change.kind === "delete") this.hooks.onEntry({ kind: "tool", text: `Deleted ${change.path}` });
          else await this.tracker.applied(change.path, change.kind === "add");
        }
      } else if (item.type === "web_search") {
        this.hooks.onEntry({ kind: "tool", text: `Searched the web: ${item.query}` });
      } else if (item.type === "mcp_tool_call") {
        this.hooks.onEntry({ kind: "tool", text: `${item.server}: ${item.tool}` });
      } else if (item.type === "error") {
        // Warnings and retries ("Reconnecting... 2/5") show as progress, not as a stack of errors.
        this.hooks.onBusy(`Codex: ${item.message.slice(0, 100)}`);
      }
    } else if (event.type === "turn.failed") {
      return event.error.message;
    } else if (event.type === "error") {
      return event.message;
    }
    return undefined;
  }
}
