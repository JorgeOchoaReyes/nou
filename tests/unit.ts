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

console.log(failures ? `\n${failures} unit check(s) failed` : "\nAll unit checks passed");
process.exit(failures ? 1 : 0);
