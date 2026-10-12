/**
 * Unit tests for logic that's easy to get subtly wrong. Run: npm test
 */
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(os.tmpdir(), "nou-unit-"));
process.env.HOME = process.env.USERPROFILE = mkdtempSync(path.join(os.tmpdir(), "nou-home-"));
process.chdir(work);

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

const { cleanContent } = await import("../src/commands/index.js");
const { Timeline } = await import("../src/history/index.js");
const { discoverPlugins, isEnabled, trustPatch } = await import("../src/plugins/index.js");
const { Agent } = await import("../src/agent/index.js");
const { DiagnosticsManager, touchedLines } = await import("../src/diagnostics/index.js");
const { DEFAULT_SETTINGS } = await import("../src/config/index.js");
const { parseMouse } = await import("../src/ui/mouse.js");

console.log("Mouse input");
{
  const events = parseMouse("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<68;3;4M\x1b[<0;20;8M\x1b[<0;20;8m");
  check("wheel up and down", events[0]?.kind === "wheel" && events[0].dir === -1 && events[1]?.kind === "wheel" && events[1].dir === 1);
  check("wheel with Shift held still counts", events[2]?.kind === "wheel" && events[2].dir === -1);
  check("click press is reported once (release ignored)", events.filter((e) => e.kind === "click").length === 1);
  check("positions are 0-based", events[3]?.x === 19 && events[3]?.y === 7);
  check("ordinary keys are not mouse events", parseMouse("hello\x1b[A").length === 0);
}

console.log("write_file content");
check("keeps \\n inside string literals", cleanContent('log("a\\nb");\n') === 'log("a\\nb");\n');
check("keeps leading indentation", cleanContent("    x()\n") === "    x()\n");
check("unescapes a file sent as one escaped line", cleanContent("a\\nb") === "a\nb\n");
check("unwraps a fenced file", cleanContent("```ts\nconst a = 1;\n```") === "const a = 1;\n");

console.log("Undo history");
{
  writeFileSync("a.txt", "old a\n");
  writeFileSync("b.txt", "old b\n");
  const yesterday = new Timeline();
  writeFileSync("a.txt", "new a\n");
  yesterday.record({ path: "a.txt", before: "old a\n", after: "new a\n", source: "nou", turn: "sessionA:1" });
  const today = new Timeline(); // a restart: reloads history from disk
  writeFileSync("b.txt", "new b\n");
  today.record({ path: "b.txt", before: "old b\n", after: "new b\n", source: "nou", turn: "sessionB:1" });
  const turn = today.lastTurn();
  check("rewind only takes this session's turn", turn.length === 1 && turn[0]!.path === "b.txt");
  for (const cp of turn) today.undo(cp);
  check("an earlier session's edit is untouched", readFileSync("a.txt", "utf-8") === "new a\n");
}

console.log("Plugin trust");
{
  const plugins = path.join(work, ".nou", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(path.join(plugins, "tool.mjs"), "export default { name: 'tool' };\n");
  const [mine] = discoverPlugins();
  const settings = { ...DEFAULT_SETTINGS, ...trustPatch(mine!, true, DEFAULT_SETTINGS) };
  check("approved plugin is enabled", isEnabled(mine!, settings));
  // A different repo with a plugin of the same name must not inherit the approval.
  const other = mkdtempSync(path.join(os.tmpdir(), "nou-other-"));
  const impostor = { ...mine!, file: path.join(other, "tool.mjs"), root: path.join(other, "tool.mjs") };
  check("same-named plugin elsewhere is not enabled", !isEnabled(impostor, settings));
  writeFileSync(path.join(plugins, "tool.mjs"), "export default { name: 'tool', evil: true };\n");
  const [changed] = discoverPlugins();
  check("a trusted plugin whose code changed is disabled", !isEnabled(changed!, settings));
}

console.log("Tool-call ids");
{
  const seen: string[][] = [];
  let call = 0;
  // A provider that (like Ollama used to) numbers every response's calls from call_0.
  const provider: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "f", unavailable: () => null, listModels: async () => [],
    async chat({ messages }: any) {
      seen.push(messages.flatMap((m: any) => (m.role === "assistant" ? m.toolCalls.map((c: any) => c.id) : [])));
      call++;
      return call % 2 ? { text: "", toolCalls: [{ id: "call_0", name: "list_files", args: {} }] } : { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider, model: "f" }, "sys", {
    onEntry() {}, onStream() {}, onBusy() {}, onRead() {}, onChange() {}, approve: async () => true,
  });
  await agent.send("one");
  await agent.send("two");
  const ids = seen.at(-1)!;
  check("repeated ids from a provider are made unique", ids.length === 2 && new Set(ids).size === 2);
}

console.log("Problems blamed on an edit");
{
  check("touchedLines finds changed and added lines", [...touchedLines("a\nb\nc\n", "a\nB\nc\nd\n")].join() === "2,4");
  let running = 0;
  let overlapped = false;
  const projectChecker: any = {
    id: "p", name: "P", checksText: false, projectWide: true, matches: () => true, available: () => true,
    async check() {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return [
        { file: "x.ts", line: 1, col: 1, severity: "error", message: "already there", source: "p" },
        { file: "x.ts", line: 3, col: 1, severity: "error", message: "caused by the edit", source: "p" },
      ];
    },
  };
  const manager = new DiagnosticsManager();
  manager.setProviders([projectChecker]);
  const blamed = await manager.introducedBy("x.ts", "1\n2\n3\n", "1\n2\nthree\n");
  check("without a baseline, only problems on edited lines are blamed", blamed.length === 1 && blamed[0]!.line === 3);
  await Promise.all([manager.checkProject(), manager.checkProject(), manager.checkProject()]);
  check("project checks never overlap", !overlapped);
}

console.log(".env loading");
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "nou-env-"));
  writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-test\nOLLAMA_HOST=http://example.invalid:1234\n");
  // Same import order as index.ts, in a fresh process run from the folder that has the .env.
  const url = (...parts: string[]) => pathToFileURL(path.join(root, ...parts)).href;
  writeFileSync(path.join(dir, "probe.mjs"), `
    await import(${JSON.stringify(url("src", "env.ts"))});
    const { providers } = await import(${JSON.stringify(url("src", "providers", "index.ts"))});
    console.log(JSON.stringify({ openai: providers.find((p) => p.id === "openai").unavailable(), ollama: providers[0].label }));
  `);
  const tsx = pathToFileURL(createRequire(path.join(root, "package.json")).resolve("tsx")).href;
  const out = JSON.parse(execFileSync(process.execPath, ["--import", tsx, "probe.mjs"], { cwd: dir, encoding: "utf-8" }).trim().split("\n").at(-1)!);
  check("OpenAI key from .env is seen by the provider", out.openai === null);
  check("Ollama host from .env is used", out.ollama.includes("example.invalid"));
}

console.log("Evals");
{
  const { TASKS } = await import("../evals/tasks.js");
  const { runTask } = await import("../evals/runner.js");
  // A correct result for each task, so we know the checks pass good work (and fail the untouched project).
  const solutions: Record<string, { edit?(files: Record<string, string>): void; answer?: string }> = {
    "fix-failing-test": { edit: (f) => void (f["src/stats.js"] = f["src/stats.js"]!.replace("values.length - 1", "values.length")) },
    "implement-from-spec": {
      edit: (f) => void (f["src/slug.js"] = `export function slugify(text) {
  return text.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`),
    },
    "rename-across-files": { edit: (f) => Object.keys(f).forEach((k) => (f[k] = f[k]!.replaceAll("getUser", "fetchUser"))) },
    "edit-large-file": { edit: (f) => void (f["config/defaults.js"] = f["config/defaults.js"]!.replace("MAX_RETRIES = 3;", "MAX_RETRIES = 5;")) },
    "find-the-setting": { edit: (f) => void (f["src/net/http/client.js"] = f["src/net/http/client.js"]!.replace("= 250;", "= 1000;")) },
    "answer-without-editing": { answer: "It returns 5400000 (90 minutes in ms)." },
  };
  check("every task has a reference solution", TASKS.every((t) => solutions[t.name]));
  for (const task of TASKS) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nou-evalcheck-"));
    const write = (files: Record<string, string>) => {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), content);
      }
    };
    write(task.files);
    const untouched = task.check({ dir, answer: "", original: task.files });
    const solved = { ...task.files };
    solutions[task.name]?.edit?.(solved);
    write(solved);
    const good = task.check({ dir, answer: solutions[task.name]?.answer ?? "", original: task.files });
    check(`${task.name}: fails untouched, passes when solved${good ? ` (${good})` : ""}`, untouched !== null && good === null);
  }

  // The runner end to end, with a scripted model that fixes the bug.
  let turn = 0;
  const solver: any = {
    id: "script", label: "Script", local: true, defaultModel: "s", unavailable: () => null, listModels: async () => [],
    async chat() {
      turn++;
      if (turn === 1) return { text: "", toolCalls: [{ id: "a", name: "read_file", args: { path: "src/stats.js" } }] };
      if (turn === 2) return { text: "", toolCalls: [{ id: "b", name: "edit_file", args: { path: "src/stats.js", old_string: "values.length - 1", new_string: "values.length" } }] };
      return { text: "Fixed the off-by-one in average().", toolCalls: [] };
    },
  };
  const task = TASKS.find((t) => t.name === "fix-failing-test")!;
  const before = process.cwd();
  const result = await runTask({ provider: solver, model: "s" }, task);
  check("the eval runner scores a solved task", result.pass && result.steps === 3 && result.toolCalls.edit_file === 1 && process.cwd() === before);
  const idle: any = { ...solver, chat: async () => ({ text: "No idea.", toolCalls: [] }) };
  const failed = await runTask({ provider: idle, model: "s" }, task);
  check("the eval runner fails an unsolved task, with the reason", !failed.pass && !!failed.reason?.includes("tests still fail"));
}

console.log(failures ? `\n${failures} unit check(s) failed` : "\nAll unit checks passed");
process.exit(failures ? 1 : 0);
