/**
 * Runs the eval tasks against real models and reports how the agent did.
 *
 *   npm run eval -- --model ollama:qwen3:8b --model anthropic --repeat 3
 *   npm run eval -- --task fix-failing-test --keep
 *
 * Everything the model does is auto-approved (edits and commands), in temporary folders. Run it on a
 * machine or container you don't mind a model running commands on.
 */
import "../src/env.js";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, resolveModel } from "../src/providers/index.js";
import { lsp } from "../src/lsp/index.js";
import { runTask, type RunResult } from "./runner.js";
import { TASKS } from "./tasks.js";

const USAGE = `Usage: npm run eval -- [--model provider:model]... [--task name]... [--repeat n] [--timeout minutes] [--keep]
Models default to NOU_MODEL, or ollama. Tasks: ${TASKS.map((t) => t.name).join(", ")}`;

function parseArgs(argv: string[]) {
  const options = { models: [] as string[], tasks: [] as string[], repeat: 1, timeoutMinutes: 10, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--model" || arg === "-m") options.models.push(value());
    else if (arg === "--task" || arg === "-t") options.tasks.push(value());
    else if (arg === "--repeat" || arg === "-n") options.repeat = Math.max(1, Number(value()) || 1);
    else if (arg === "--timeout") options.timeoutMinutes = Math.max(1, Number(value()) || 10);
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  if (!options.models.length) options.models.push(process.env.NOU_MODEL || "ollama");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const tasks = options.tasks.length ? TASKS.filter((t) => options.tasks.includes(t.name)) : TASKS;
const unknown = options.tasks.filter((name) => !TASKS.some((t) => t.name === name));
if (unknown.length) {
  console.error(`Unknown task(s): ${unknown.join(", ")}\n${USAGE}`);
  process.exit(1);
}

const results: RunResult[] = [];
for (const spec of options.models) {
  const choice = resolveModel(spec);
  const problem = choice.provider.unavailable();
  if (problem) {
    console.error(`Skipping ${describe(choice)}: ${problem}`);
    continue;
  }
  console.log(`\n${describe(choice)}`);
  for (const task of tasks) {
    for (let run = 1; run <= options.repeat; run++) {
      const result = await runTask(choice, task, { timeoutMs: options.timeoutMinutes * 60_000, keep: options.keep });
      results.push(result);
      const tools = Object.entries(result.toolCalls).map(([name, n]) => `${name}×${n}`).join(" ") || "no tools";
      const label = `${task.name}${options.repeat > 1 ? ` #${run}` : ""}`;
      console.log(`  ${result.pass ? "✓" : "✗"} ${label.padEnd(26)} ${String(result.steps).padStart(2)} steps ${`${result.seconds}s`.padStart(7)}  ${tools}`);
      if (!result.pass) console.log(`      ${result.reason?.split("\n").join("\n      ")}`);
      if (result.dir) console.log(`      kept: ${result.dir}`);
    }
  }
}
lsp.stopAll();

if (!results.length) process.exit(1);

console.log("\nSummary");
for (const model of [...new Set(results.map((r) => r.model))]) {
  const runs = results.filter((r) => r.model === model);
  const passed = runs.filter((r) => r.pass).length;
  const avg = (pick: (r: RunResult) => number) => Math.round((runs.reduce((sum, r) => sum + pick(r), 0) / runs.length) * 10) / 10;
  console.log(`  ${model.padEnd(32)} ${passed}/${runs.length} passed (${Math.round((passed / runs.length) * 100)}%) · avg ${avg((r) => r.steps)} steps · avg ${avg((r) => r.seconds)}s · avg ${avg((r) => r.errors)} errors · largest request ${Math.max(...runs.map((r) => r.maxRequestChars)).toLocaleString()} chars`);
}

// Kept for comparing runs over time (gitignored).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
process.exit(0);
