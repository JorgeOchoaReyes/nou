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
// Fake engine packages (see fake-engines.ts); set before the engines module reads it.
process.env.NOU_ENGINE_DIR = mkdtempSync(path.join(os.tmpdir(), "nou-engines-"));

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

console.log("Keeping the model's context small");
{
  const { readForModel, capOutput } = await import("../src/commands/index.js");
  const { pickNumCtx } = await import("../src/providers/ollama.js");
  writeFileSync("small.txt", "one\r\ntwo\r\n");
  check("a small file is returned unchanged", (await readForModel("small.txt")) === "one\r\ntwo\r\n");
  writeFileSync("big.txt", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const page = await readForModel("big.txt");
  check("a long file comes back one page at a time", page.includes("line 1000\n") && !page.includes("line 1001") && page.includes("Read more with offset=1001"));
  const last = await readForModel("big.txt", 2001, 1000);
  check("offset reads on to the end", last.startsWith("line 2001\n") && last.includes("[Lines 2001-2500 of 2500.]"));
  const capped = capOutput("a".repeat(30_000) + "THE ERROR", 10_000);
  check("long output keeps its end, where errors are", capped.length < 10_100 && capped.endsWith("THE ERROR") && capped.includes("characters cut"));
  check("Ollama gets a bigger context window, capped at the model's", pickNumCtx("temperature 0.6", { "qwen3.context_length": 40960 }) === 32768 && pickNumCtx("", { "x.context_length": 8192 }) === 8192);
  check("a num_ctx set in the Modelfile is left alone", pickNumCtx("num_ctx                        24576\ntop_k 20", {}) === null);
}

console.log("edit_file");
{
  const { proposeEdit } = await import("../src/commands/index.js");
  writeFileSync("rename.js", "import { getUser } from \"./u.js\";\r\nconst u = getUser(1);\r\n");
  const refused = await proposeEdit("rename.js", "getUser", "fetchUser").then(() => "", (e: Error) => e.message);
  check("a repeated old_string is refused, pointing at replace_all", refused.includes("appears 2 times") && refused.includes("replace_all"));
  const all = await proposeEdit("rename.js", "getUser", "fetchUser", true);
  check("replace_all changes every match and keeps CRLF", all.after === "import { fetchUser } from \"./u.js\";\r\nconst u = fetchUser(1);\r\n");
}

console.log("Cancelling Ollama while it reads the prompt");
{
  const { createServer } = await import("http");
  // Like Ollama busy with a long prompt: takes the request and doesn't answer.
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${(server.address() as any).port}`;
  const { ollamaProvider } = await import("../src/providers/ollama.js");
  const provider = ollamaProvider();
  if (saved === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = saved;
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const outcome = await Promise.race([
    provider.chat({ model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [], onText() {}, signal: controller.signal }).then(() => "answered", () => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
  ]);
  check("Esc stops a request Ollama hasn't started answering", outcome === "stopped" && Date.now() - started < 2000);
  server.closeAllConnections();
  server.close();
}

console.log("Undo history");
{
  writeFileSync("a.txt", "old a\n");
  writeFileSync("b.txt", "old b\n");
  const yesterday = new Timeline();
  writeFileSync("a.txt", "new a\n");
  yesterday.record({ path: "a.txt", before: "old a\n", after: "new a\n", source: "nou", turn: "sessionA:1" });
  yesterday.flush(); // what quitting does
  const today = new Timeline(); // a restart: reloads history from disk
  writeFileSync("b.txt", "new b\n");
  today.record({ path: "b.txt", before: "old b\n", after: "new b\n", source: "nou", turn: "sessionB:1" });
  const turn = today.lastTurn();
  check("rewind only takes this session's turn", turn.length === 1 && turn[0]!.path === "b.txt");
  for (const cp of turn) today.undo(cp);
  check("an earlier session's edit is untouched", readFileSync("a.txt", "utf-8") === "new a\n");

  const sessions = today.sessions();
  check("sessions are listed newest first", sessions.map((s) => s.id).join() === "sessionB,sessionA");
  check("a session's diff is its own changes", JSON.stringify(today.sessionChanges("sessionA")) === JSON.stringify([{ path: "a.txt", before: "old a\n", after: "new a\n", isNew: false }]));
  check("a change undone in the same session nets out", today.sessionChanges("sessionB").length === 0);
  today.record({ path: "n.txt", before: null, after: "one\n", source: "nou", turn: "sessionC:1" });
  today.record({ path: "n.txt", before: "one\n", after: "two\n", source: "you", turn: "sessionC:2" });
  const created = today.sessionChanges("sessionC");
  check("several edits to a file combine into one diff", created.length === 1 && created[0]!.isNew && created[0]!.before === "" && created[0]!.after === "two\n");
}

console.log("Reusing Claude Code and Codex config");
{
  const home = os.homedir();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_MODEL: "claude-sonnet-5-5" } }));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-codex-test" }));
  writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5-codex"\n\n[profiles.fast]\nmodel = "gpt-5"\n');
  const saved = { a: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN, o: process.env.OPENAI_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.OPENAI_API_KEY = "sk-mine";
  const { borrowToolConfig } = await import("../src/setup/index.js");
  const borrowed = borrowToolConfig();
  check("Claude Code's API key is used when none is set", process.env.ANTHROPIC_API_KEY === "sk-ant-test" && borrowed.some((b) => b.tool === "Claude Code"));
  check("only a full Claude model id is taken", borrowed.find((b) => b.tool === "Claude Code")?.model === "claude-sonnet-5-5");
  check("your own OpenAI key wins over Codex's", process.env.OPENAI_API_KEY === "sk-mine" && !borrowed.some((b) => b.tool === "Codex"));
  for (const [name, value] of [["ANTHROPIC_API_KEY", saved.a], ["ANTHROPIC_AUTH_TOKEN", saved.t], ["OPENAI_API_KEY", saved.o]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

console.log("Reading outside the project");
{
  writeFileSync(path.join(os.tmpdir(), "nou-outside.txt"), "SECRET\n");
  const results: string[] = [];
  const asked: any[] = [];
  let step = 0;
  const provider: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "f", unavailable: () => null, listModels: async () => [],
    async chat({ messages }: any) {
      const last = messages.at(-1);
      if (last.role === "tool") results.push(last.content);
      step++;
      if (step === 1) return { text: "", toolCalls: [{ id: "r1", name: "read_file", args: { path: path.join(os.tmpdir(), "nou-outside.txt") } }] };
      if (step === 2) return { text: "", toolCalls: [{ id: "r2", name: "read_file", args: { path: "small.txt" } }] };
      return { text: "<think>long musing</think>done", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider, model: "f" }, "sys", {
    onEntry() {}, onStream() {}, onBusy() {}, onRead() {}, onChange() {},
    approve: async (request) => {
      asked.push(request);
      return false;
    },
  });
  await agent.send("read it");
  check("reading outside the project asks first", asked.length === 1 && !results[0]!.includes("SECRET") && results[0]!.includes("denied"));
  check("reading inside the project doesn't ask", asked.length === 1 && results[1] === "one\r\ntwo\r\n");
  const history = (agent as any).messages as any[];
  check("<think> blocks aren't sent back to the model", history.at(-1).content === "done");
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

console.log("Search tools");
{
  const { grep, globFiles, globToRegex } = await import("../src/search/index.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "nou-search-"));
  const home = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync("src/util", { recursive: true });
    mkdirSync("node_modules/lib", { recursive: true });
    writeFileSync("src/app.ts", "import { add } from './util/math';\nexport const total = add(1, 2);\n");
    writeFileSync("src/util/math.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    writeFileSync("src/util/math.test.ts", "import { add } from './math';\n");
    writeFileSync("node_modules/lib/add.js", "function add() {}\n");
    writeFileSync("README.md", "Call ADD to sum.\n");
    check("grep finds definitions with file:line", grep({ pattern: "function add" }) === "src/util/math.ts:1: export function add(a: number, b: number) {");
    check("grep skips node_modules", !grep({ pattern: "add" }).includes("node_modules"));
    check("grep filters by glob", !grep({ pattern: "add", glob: "*.test.ts" }).includes("app.ts") && grep({ pattern: "add", glob: "*.test.ts" }).includes("math.test.ts"));
    check("grep ignore_case", grep({ pattern: "add to", ignoreCase: true }).includes("README.md:1:"));
    check("grep files_only counts per file", grep({ pattern: "add", filesOnly: true }).includes("src/app.ts (2)"));
    check("grep context shows nearby lines", grep({ pattern: "return a", context: 1 }).split("\n").length === 3);
    check("an invalid regex is searched as text", grep({ pattern: "add(" }).includes("src/app.ts:2:"));
    check("grep says when nothing matches", grep({ pattern: "nope" }).startsWith("No matches"));
    check("grep refuses paths outside the project", grep({ pattern: "x", path: ".." }).includes("outside"));
    writeFileSync("many.txt", Array.from({ length: 300 }, () => "hit").join("\n"));
    check("grep caps matches and says how many there were", grep({ pattern: "hit" }).includes("[300 matches in 1 files; showing the first 100"));
    check("glob ** crosses folders", globFiles("src/**/*.ts").split("\n").length === 3);
    check("glob without a slash matches names anywhere", globFiles("*.test.ts") === "src/util/math.test.ts");
    check("glob {a,b}", globToRegex("*.{md,txt}").test("README.md") && globToRegex("*.{md,txt}").test("a/many.txt") && !globToRegex("*.{md,txt}").test("x.ts"));
    check("glob says when nothing matches", globFiles("*.py").startsWith("No files"));
  } finally {
    process.chdir(home);
  }
}

console.log("Compaction");
{
  const { Agent } = await import("../src/agent/index.js");
  const requests: any[] = [];
  const provider: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "f", unavailable: () => null, listModels: async () => [],
    async chat(request: any) {
      requests.push(request);
      if (!request.tools.length) return { text: "<think>hmm</think>SUMMARY: user wants a report; read big.txt.", toolCalls: [] };
      const step = requests.filter((r) => r.tools.length).length;
      if (step <= 4) return { text: "", toolCalls: [{ id: `c${step}`, name: "read_file", args: { path: "big.txt" } }] };
      return { text: "Done.", toolCalls: [] };
    },
  };
  writeFileSync(path.join(work, "big.txt"), "x".repeat(30_000));
  const entries: any[] = [];
  const agent = new Agent({ provider, model: "f" }, "system", {
    onEntry: (e) => entries.push(e), onStream: () => {}, onBusy: () => {}, onRead: () => {}, onChange: () => {}, approve: async () => true,
  });
  process.env.NOU_CONTEXT_CHARS = "60000";
  try {
    await agent.send("first question");
    await agent.send("now make the report");
    const messages = (agent as any).messages as any[];
    const toolRequests = requests.filter((r) => r.tools.length);
    check("big tool outputs from earlier turns are trimmed", JSON.stringify(messages).includes("trimmed to save context"));
    check("requests stay within the context budget", toolRequests.every((r) => r.system.length + JSON.stringify(r.messages).length < 60_000));
    await agent.compact(true);
    const summarized = (agent as any).messages as any[];
    check("/compact summarizes older messages, dropping <think>", summarized[0].role === "user" && summarized[0].content.startsWith("[Summary of the conversation so far]\nSUMMARY:"));
    const ids = new Set<string>();
    let paired = true;
    for (const m of summarized) {
      if (m.role === "assistant") m.toolCalls.forEach((c: any) => ids.add(c.id));
      if (m.role === "tool" && !ids.has(m.callId)) paired = false;
    }
    check("every tool result still follows its call after summarizing", paired && summarized.length < messages.length);
    check("the user is told the conversation was summarized", entries.some((e) => e.kind === "info" && e.text.startsWith("Summarized")));
  } finally {
    delete process.env.NOU_CONTEXT_CHARS;
  }
}

console.log("Engines");
{
  const { ENGINES, createEngine, isInstalled } = await import("../src/engines/index.js");
  const { resolveModel } = await import("../src/providers/index.js");
  const { writeFakeEngines } = await import("./fake-engines.js");
  check("external engines aren't installed until picked", ENGINES.filter((e) => e.package).every((e) => !isInstalled(e)));
  writeFakeEngines(process.env.NOU_ENGINE_DIR!);
  check("installed engines are found in the engines folder", ENGINES.every((e) => isInstalled(e)));
  const engines = () => (globalThis as any).__engines;

  /** Runs one message through an engine in a fresh folder, approving everything unless `reject` says otherwise. */
  const runEngine = async (id: any, spec: string, reject: Partial<Record<string, boolean>> = {}, problems: string | null = null) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `nou-engine-${id}-`));
    writeFileSync(path.join(dir, "greet.js"), "export const greet = (name) => 'Hello ' + name;\n");
    const home = process.cwd();
    process.chdir(dir);
    const log = { entries: [] as any[], changes: [] as any[], asked: [] as any[] };
    const engine = createEngine(id, resolveModel(spec), "system", {
      onEntry: (e) => log.entries.push(e),
      onStream: () => {},
      onBusy: () => {},
      onRead: () => {},
      onChange: (change, status, turn) => log.changes.push({ path: change.path, before: change.before, after: change.after, status, turn }),
      approve: async (request) => {
        log.asked.push(request);
        return !reject[request.kind];
      },
      checkChange: async () => problems,
    });
    engine.configure({ extras: ["Project note: be brief."] });
    try {
      await engine.send("Change the greeting");
      return { ...log, engine, file: readFileSync(path.join(dir, "greet.js"), "utf-8"), dir };
    } finally {
      process.chdir(home);
    }
  };

  // Claude Code: edits and commands go through Nou's approval, with a diff, before they happen.
  const claude = await runEngine("claude-code", "anthropic:claude-opus-5-5", {}, "greet.js:1 something broke");
  const options = engines().claude.calls[0].options;
  check("Claude Code asks Nou before every edit and command", options.permissionMode === "default" && engines().claude.decision === "allow" && engines().claude.command === "allow");
  check("Claude Code's edit is previewed as a diff before it's made", claude.asked[0]?.kind === "change" && claude.asked[0].change.after.includes("'Hi '"));
  check("Claude Code's applied edit is recorded for undo", claude.changes.some((c) => c.status === "applied" && c.before.includes("Hello") && c.after.includes("Hi") && c.turn === `${claude.engine.session}:1`));
  check("reads are left to Claude Code (no prompt)", Object.keys(engines().claude.read).length === 0 && claude.asked.length === 2);
  check("problems from an edit are fed back to Claude Code", engines().claude.post.hookSpecificOutput?.additionalContext?.includes("something broke"));
  check("Nou's project context is added to Claude Code's prompt", options.systemPrompt.append.includes("be brief") && options.model === "claude-opus-5-5");
  check("Claude Code's reply shows in the chat", claude.entries.some((e) => e.kind === "assistant" && e.text === "Done."));
  await claude.engine.send("And again");
  check("the next message resumes the same Claude Code session", engines().claude.calls[1].options.resume === "claude-session-1");

  const rejected = await runEngine("claude-code", "ollama:qwen3:8b", { change: true });
  check("a rejected edit is denied and never written", engines().claude.decision === "deny" && rejected.file.includes("Hello") && rejected.changes.some((c) => c.status === "rejected"));
  check("Claude Code uses its own default model when Nou's isn't a Claude model", !("model" in engines().claude.calls.at(-1).options));

  // Codex: no approval hook, so changes are shown and recorded afterwards.
  const codex = await runEngine("codex", "openai:gpt-5");
  check("Codex runs in its sandbox without asking", engines().codex.threads[0].sandboxMode === "workspace-write" && engines().codex.threads[0].approvalPolicy === "never" && codex.asked.length === 0);
  check("Codex's edit is recorded for undo with the file as it was", codex.changes.some((c) => c.path === "greet.js" && c.status === "applied" && c.before.includes("Hello") && c.after.includes("Howdy")));
  check("files Codex creates are recorded as new", codex.changes.some((c) => c.path === "notes.md" && c.before === "" && c.status === "applied"));
  check("Nou's project context goes with Codex's first message", engines().codex.inputs[0].includes("be brief") && codex.entries.some((e) => e.text === "Ran: ls"));

  // pi: an extension routes its edits through Nou; local models go through Nou's endpoint for them.
  const pi = await runEngine("pi", "ollama:qwen3:8b");
  check("pi uses Nou's Ollama endpoint for a local model", engines().pi.registered[0]?.config.baseUrl.endsWith("/v1") && engines().pi.model.id === "qwen3:8b");
  check("pi's edit is previewed and recorded", pi.asked[0]?.kind === "change" && pi.asked[0].change.after.includes("'Hey '") && pi.changes.some((c) => c.status === "applied"));
  check("Nou's project context is added to pi's prompt", engines().pi.system.includes("Project note: be brief.") && engines().pi.system[0] === "base");
  await runEngine("pi", "anthropic:claude-opus-5-5");
  check("pi uses its built-in provider when it has the model", engines().pi.model.provider === "anthropic" && engines().pi.registered.length === 1);
  const piRejected = await runEngine("pi", "ollama:qwen3:8b", { change: true });
  check("a rejected pi edit is blocked", !!engines().pi.blocked && piRejected.file.includes("Hello"));
  piRejected.engine.clear();
  check("clearing ends the pi session", engines().pi.disposed === true);
}

console.log(failures ? `\n${failures} unit check(s) failed` : "\nAll unit checks passed");
process.exit(failures ? 1 : 0);
