// Starter plugin: lets the model (and you, with /test) run the project's tests.
// It's yours to edit: set TEST_COMMAND if the guess below picks the wrong command.
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import process from "process";

/** e.g. "npm run test:unit". Leave null to guess from the project files. */
const TEST_COMMAND = null;
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 12_000;

function guessCommand(cwd) {
  const has = (file) => existsSync(path.join(cwd, file));
  if (has("package.json")) {
    const test = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")).scripts?.test;
    if (test && !test.includes("no test specified")) {
      if (has("pnpm-lock.yaml")) return "pnpm test";
      if (has("yarn.lock")) return "yarn test";
      if (has("bun.lock") || has("bun.lockb")) return "bun test";
      return "npm test";
    }
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("tox.ini")) return "python -m pytest -q";
  if (has("Makefile") && /^test:/m.test(readFileSync(path.join(cwd, "Makefile"), "utf-8"))) return "make test";
  return null;
}

/** Runs the tests; extra arguments (a file, a filter) go after the command. */
function runTests(cwd, extra) {
  const base = TEST_COMMAND ?? guessCommand(cwd);
  if (!base) return Promise.resolve({ command: null, code: null, output: "Couldn't tell how to run this project's tests. Set TEST_COMMAND in the run-tests plugin." });
  const separator = extra && /^(npm|pnpm) /.test(base) ? " --" : "";
  const command = extra ? `${base}${separator} ${extra}` : base;
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (error) => (output += `\n${error.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      // The end of a test run (failures, summary) matters most.
      const text = output.length > MAX_OUTPUT ? `[... ${output.length - MAX_OUTPUT} chars cut]\n${output.slice(-MAX_OUTPUT)}` : output;
      resolve({ command, code, output: text.trim() });
    });
  });
}

export default {
  name: "Run tests",
  version: "0.1.0",
  description: "Adds a run_tests tool and /test. Works out npm/pnpm/yarn/bun, cargo, go, pytest or make.",
  systemPrompt: "After changing code, use run_tests to check your work, and fix any failures you caused.",

  tools: [
    {
      // Running tests runs project code, so you approve each run.
      definition: {
        name: "run_tests",
        description: "Run the project's test suite (or part of it) and return the output",
        parameters: {
          type: "object",
          properties: { args: { type: "string", description: "Optional extra arguments, e.g. a test file or name filter" } },
        },
      },
      async run(args, ctx) {
        const { command, code, output } = await runTests(ctx.cwd, args.args?.trim());
        return command ? `$ ${command}\nexit code ${code}\n${output}` : output;
      },
    },
  ],

  commands: [
    {
      name: "test",
      description: "Run the tests: /test [args]",
      async run(args, ctx) {
        const { command, code, output } = await runTests(ctx.cwd, args.trim());
        if (!command) return output;
        const tail = output.split("\n").slice(-25).join("\n");
        return `${code === 0 ? "✓ passed" : `✗ failed (exit ${code})`}: ${command}\n${tail}`;
      },
    },
  ],
};
