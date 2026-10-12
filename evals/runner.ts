import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { buildSystemPrompt } from "../src/agent/index.js";
import { createEngine, engineInfo, type EngineId } from "../src/engines/index.js";
import { harness, problemsIntroduced } from "../src/agent/harness.js";
import { DiagnosticsManager } from "../src/diagnostics/index.js";
import { BUILTIN_PLUGINS } from "../src/plugins/index.js";
import { describe, type ModelChoice, type Provider } from "../src/providers/index.js";
import type { Task } from "./tasks.js";

export type RunResult = {
  model: string;
  task: string;
  pass: boolean;
  /** Why it failed (check output or the agent's error). */
  reason: string | null;
  /** The model's last reply, to see why a run went wrong. */
  lastReply: string;
  /** Model requests in the turn. */
  steps: number;
  toolCalls: Record<string, number>;
  /** Tool errors and problems reported back to the model. */
  errors: number;
  /** Size of the largest request (system prompt + history), in characters: how close it came to the context limit. */
  maxRequestChars: number;
  seconds: number;
  /** The project folder, when kept for inspection. */
  dir?: string;
};

/**
 * Runs one task in a fresh temporary copy of its project, with the same agent, tools and problem checks
 * as the app. Everything is auto-approved, including commands, so run evals somewhere disposable.
 */
export async function runTask(choice: ModelChoice, task: Task, options: { timeoutMs?: number; keep?: boolean; engine?: EngineId } = {}): Promise<RunResult> {
  const engine = options.engine ?? "nou";
  const home = process.cwd();
  const dir = mkdtempSync(path.join(os.tmpdir(), `nou-eval-${task.name}-`));
  for (const [file, content] of Object.entries(task.files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }

  let steps = 0;
  let maxRequestChars = 0;
  const counted: Provider = {
    ...choice.provider,
    chat: (request) => {
      steps++;
      maxRequestChars = Math.max(maxRequestChars, request.system.length + JSON.stringify(request.messages).length);
      return choice.provider.chat(request);
    },
  };

  const toolCalls: Record<string, number> = {};
  const said: string[] = [];
  let errors = 0;
  let agentError = null as string | null;
  const started = Date.now();
  process.chdir(dir);
  const diagnostics = new DiagnosticsManager();
  try {
    const plugins = BUILTIN_PLUGINS.flatMap((p) => (p.plugin ? [p.plugin] : []));
    diagnostics.setProviders(plugins.flatMap((p) => p.diagnostics ?? []));
    const { extras, extraTools } = harness({ diagnostics, plugins, git: false });
    const agent = createEngine(engine, { provider: counted, model: choice.model }, buildSystemPrompt("", extras), {
      onEntry(entry) {
        if (entry.kind === "assistant") said.push(entry.text);
        // Other engines don't report through Nou's busy line; count their tools from the chat instead.
        if (entry.kind === "tool" && engine !== "nou") {
          const tool = entry.text.split(/[\s:]/)[0]!;
          toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
        }
        if (entry.kind === "error") {
          errors++;
          agentError = entry.text;
        }
      },
      onStream() {},
      onBusy(label) {
        const tool = label?.match(/^Running (\S+)\.\.\.$/)?.[1];
        if (tool) toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
      },
      onRead() {},
      onChange() {},
      approve: async () => true,
      checkChange: (change) => problemsIntroduced(diagnostics, change),
    });
    agent.configure({ system: buildSystemPrompt("", extras), extras, extraTools });
    const timer = setTimeout(() => agent.cancel(), options.timeoutMs ?? 10 * 60_000);
    try {
      await agent.send(task.prompt);
    } finally {
      clearTimeout(timer);
    }

    const answer = said.join("\n");
    let reason: string | null;
    try {
      reason = task.check({ dir, answer, original: task.files });
    } catch (error: any) {
      reason = `check crashed: ${error.message}`;
    }
    // A run that did nothing usually failed to reach the model: say so instead of a confusing check failure.
    if (reason && steps <= 1 && !Object.keys(toolCalls).length && agentError) reason = agentError;
    return {
      lastReply: said.at(-1) ?? "",
      model: engine === "nou" ? describe(choice) : `${engine} · ${engineInfo(engine).model(choice)}`, task: task.name, pass: reason === null, reason, steps, toolCalls, errors, maxRequestChars,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      ...(options.keep ? { dir } : {}),
    };
  } finally {
    process.chdir(home);
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}
