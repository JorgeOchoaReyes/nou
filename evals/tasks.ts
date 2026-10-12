/**
 * Eval tasks: a small project, what the user asks, and a check of the result. Checks are hidden from the
 * model (they run after it's done), so passing means the work is right, not that it matched a visible test.
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

export type CheckContext = {
  dir: string;
  /** Everything the model said to the user, joined. */
  answer: string;
  /** The project's files before the run. */
  original: Record<string, string>;
};

export type Task = {
  name: string;
  /** What it tests, for the report. */
  skill: string;
  files: Record<string, string>;
  prompt: string;
  /** null when the task passed, otherwise why it failed. */
  check(ctx: CheckContext): string | null;
};

const read = (dir: string, file: string) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf-8") : null);

/** Runs a JS module in the project; null if it exits cleanly, otherwise its error output. */
function runNode(dir: string, code: string): string | null {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf-8", timeout: 30_000 });
  return result.status === 0 ? null : (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").slice(0, 6).join("\n");
}

/** Every file in the project, relative, with forward slashes. */
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, "/")]);
}

/** Files that differ from the original, plus new ones. */
function changedFiles(ctx: CheckContext): string[] {
  const now = listFiles(ctx.dir);
  return [
    ...now.filter((f) => ctx.original[f] !== read(ctx.dir, f)),
    ...Object.keys(ctx.original).filter((f) => !now.includes(f)),
  ];
}

const norm = (text: string | null) => text?.replace(/\r\n/g, "\n") ?? null;
const PKG = JSON.stringify({ name: "fixture", type: "module", private: true }, null, 2) + "\n";

const bigConfig = (() => {
  const lines = Array.from({ length: 3000 }, (_, i) => `export const SETTING_${i + 1} = ${i + 1};`);
  lines[2599] = "export const MAX_RETRIES = 3;";
  return lines.join("\n") + "\n";
})();

export const TASKS: Task[] = [
  {
    name: "fix-failing-test",
    skill: "debug from a failing test, without touching the test",
    files: {
      "package.json": PKG,
      "src/stats.js": `export function average(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / (values.length - 1);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
`,
      "test.mjs": `import assert from "node:assert/strict";
import { average, median } from "./src/stats.js";

assert.equal(average([2, 4, 6]), 4);
assert.equal(average([]), 0);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
console.log("ok");
`,
    },
    prompt: "The tests in test.mjs fail. Find the bug and fix it. Don't change the tests.",
    check(ctx) {
      if (norm(read(ctx.dir, "test.mjs")) !== norm(ctx.original["test.mjs"]!)) return "changed the test";
      const failed = runNode(ctx.dir, "await import(\"./test.mjs\");");
      if (failed) return `tests still fail: ${failed}`;
      return runNode(ctx.dir, `
        import assert from "node:assert/strict";
        import { average } from "./src/stats.js";
        assert.equal(average([10]), 10);
        assert.equal(average([1, 2]), 1.5);
      `) && "average() is still wrong for other inputs";
    },
  },
  {
    name: "implement-from-spec",
    skill: "write a function from a written spec, with edge cases",
    files: {
      "package.json": PKG,
      "src/slug.js": `/** Turns a title into a URL slug. */
export function slugify(text) {
  throw new Error("not implemented");
}
`,
    },
    prompt: `Implement slugify in src/slug.js:
- lowercase the text
- turn accented letters into plain ones (é -> e, ñ -> n)
- replace every run of characters that aren't a-z or 0-9 with a single "-"
- no "-" at the start or end
Examples: "Hello, World!" -> "hello-world", "  Crème Brûlée  " -> "creme-brulee".`,
    check(ctx) {
      return runNode(ctx.dir, `
        import assert from "node:assert/strict";
        import { slugify } from "./src/slug.js";
        assert.equal(slugify("Hello, World!"), "hello-world");
        assert.equal(slugify("  Crème Brûlée  "), "creme-brulee");
        assert.equal(slugify("Año 2024 -- Review"), "ano-2024-review");
        assert.equal(slugify("---"), "");
        assert.equal(slugify("a_b.c"), "a-b-c");
      `);
    },
  },
  {
    name: "rename-across-files",
    skill: "consistent change across several files",
    files: {
      "package.json": PKG,
      "src/users.js": `const USERS = { 1: { id: 1, name: "Ada" }, 2: { id: 2, name: "Linus" } };

export function getUser(id) {
  return USERS[id] ?? null;
}
`,
      "src/api.js": `import { getUser } from "./users.js";

export function handle(request) {
  const user = getUser(request.id);
  return user ? { status: 200, body: user } : { status: 404, body: null };
}
`,
      "src/cli.js": `import { getUser } from "./users.js";

export function describe(id) {
  const user = getUser(id);
  return user ? \`#\${user.id} \${user.name}\` : "unknown user";
}
`,
    },
    prompt: "Rename getUser to fetchUser everywhere in the project.",
    check(ctx) {
      const left = listFiles(ctx.dir).filter((f) => read(ctx.dir, f)?.includes("getUser"));
      if (left.length) return `getUser is still in ${left.join(", ")}`;
      return runNode(ctx.dir, `
        import assert from "node:assert/strict";
        import { fetchUser } from "./src/users.js";
        import { handle } from "./src/api.js";
        import { describe } from "./src/cli.js";
        assert.equal(fetchUser(1).name, "Ada");
        assert.equal(handle({ id: 2 }).status, 200);
        assert.equal(handle({ id: 9 }).status, 404);
        assert.equal(describe(1), "#1 Ada");
      `);
    },
  },
  {
    name: "edit-large-file",
    skill: "find and change one line in a 3000-line file, leaving the rest alone",
    files: { "package.json": PKG, "config/defaults.js": bigConfig },
    prompt: "Set MAX_RETRIES to 5 in config/defaults.js.",
    check(ctx) {
      const now = norm(read(ctx.dir, "config/defaults.js"));
      if (!now) return "config/defaults.js is gone";
      const expected = bigConfig.replace("MAX_RETRIES = 3;", "MAX_RETRIES = 5;");
      if (now === expected) return null;
      return now.includes("MAX_RETRIES = 5") ? "MAX_RETRIES is 5 but other lines changed too" : "MAX_RETRIES isn't 5";
    },
  },
  {
    name: "find-the-setting",
    skill: "navigate an unfamiliar project to find where something lives",
    files: {
      "package.json": PKG,
      "src/index.js": "export { request } from \"./net/index.js\";\nexport { sleep } from \"./util/time.js\";\n",
      "src/util/time.js": "export const SECOND = 1000;\n\nexport const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n",
      "src/net/index.js": "export { request } from \"./http/client.js\";\n",
      "src/net/http/client.js": `import { sleep } from "../../util/time.js";

export const MAX_ATTEMPTS = 4;
export const RETRY_DELAY_MS = 250;

export async function request(send) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}
`,
    },
    prompt: "Failed requests are retried too quickly. Make it wait one second between retries.",
    check(ctx) {
      const failed = runNode(ctx.dir, `
        import assert from "node:assert/strict";
        import { RETRY_DELAY_MS, MAX_ATTEMPTS } from "./src/net/http/client.js";
        assert.equal(RETRY_DELAY_MS, 1000);
        assert.equal(MAX_ATTEMPTS, 4);
      `);
      if (failed) return failed;
      const others = changedFiles(ctx).filter((f) => f !== "src/net/http/client.js");
      return others.length ? `also changed ${others.join(", ")}` : null;
    },
  },
  {
    name: "answer-without-editing",
    skill: "read code and answer a question without changing anything",
    files: {
      "package.json": PKG,
      "src/duration.js": `const UNITS = { h: 3_600_000, m: 60_000, s: 1_000 };

/** Parses durations like "2h", "45s" or "1h30m" into milliseconds. */
export function parseDuration(text) {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\\d+)([hms])/g)) total += Number(amount) * UNITS[unit];
  return total;
}
`,
    },
    prompt: "What does parseDuration in src/duration.js return for \"1h30m\"? Just tell me the number; don't change any files.",
    check(ctx) {
      const changed = changedFiles(ctx);
      if (changed.length) return `changed files: ${changed.join(", ")}`;
      return /5[,_ ]?400[,_ ]?000/.test(ctx.answer) ? null : "the answer doesn't say 5400000";
    },
  },
];
