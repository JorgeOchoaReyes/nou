/**
 * End-to-end tests: drives the real app with simulated keypresses in a temporary project.
 * Run: npm test
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const dir = mkdtempSync(path.join(os.tmpdir(), "nou-e2e-"));
writeFileSync(path.join(dir, "a.ts"), "const a = 1;\n");
writeFileSync(path.join(dir, "b.ts"), "function broken( {\n  return 1;\n}\n");
writeFileSync(path.join(dir, "many.ts"), Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n");
writeFileSync(path.join(dir, "long.ts"), `const one = "${"a".repeat(150)}END1";\nconst two = "${"b".repeat(150)}END2";\n`);
process.chdir(dir);
process.env.NOU_NO_UPDATE_CHECK = "1";
// Keep test runs out of the real ~/.nou (history, settings).
process.env.HOME = process.env.USERPROFILE = mkdtempSync(path.join(os.tmpdir(), "nou-home-"));
process.env.NOU_ENGINE_DIR = mkdtempSync(path.join(os.tmpdir(), "nou-engines-"));

// Imported after chdir: some modules read the working directory when loaded.
const { render } = await import("ink-testing-library");
const { createElement } = await import("react");
const { App } = await import("../src/ui/App.js");
const { resolveModel } = await import("../src/providers/index.js");
const { writeFakeEngines } = await import("./fake-engines.js");

// Every frame below is rendered by both Ink's own output stage and Nou's faster one (src/ui/fast-output.ts);
// they must produce the same text, byte for byte.
const { loadInkOutput, makeFastOutput } = await import("../src/ui/fast-output.js");
const ink = await loadInkOutput();
const inkGet = ink.Output.prototype.get;
const fastGet = makeFastOutput(ink.tokenizer, ink.stringWidth).get;
const outputCompare = { frames: 0, mismatches: 0 };
ink.Output.prototype.get = function (this: any) {
  const expected = inkGet.call(this);
  const actual = fastGet.call(this);
  outputCompare.frames++;
  if (expected.output !== actual.output || expected.height !== actual.height) {
    if (!outputCompare.mismatches++) console.log("fast output differs:\n" + JSON.stringify(expected.output.slice(0, 400)) + "\n" + JSON.stringify(actual.output.slice(0, 400)));
  }
  return expected;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

async function session(model: any, steps: (h: { press(keys: string, wait?: number): Promise<void>; type(text: string): Promise<void>; frame(): string }) => Promise<void>) {
  const app = render(createElement(App, { initialModel: model, permContext: "" }));
  const h = {
    frame: () => app.lastFrame() ?? "",
    // One key per write: the input parser reads a multi-key chunk as a single unknown key.
    press: async (keys: string, wait = 150) => {
      app.stdin.write(keys);
      await delay(wait);
    },
    type: async (text: string) => {
      for (const ch of text) {
        app.stdin.write(ch);
        await delay(25);
      }
    },
  };
  await delay(600);
  try {
    await steps(h);
  } finally {
    app.unmount();
  }
}

const KEY = { tab: "\t", shiftTab: "\x1b[Z", enter: "\r", esc: "\x1b", down: "\x1b[B", end: "\x1b[F", ctrlC: "\x03", ctrlZ: "\x1a", ctrlY: "\x19", ctrlP: "\x10" };
const [SHIFT_RIGHT, ALT_UP, LEFT, CTRL_SLASH, CTRL_D, CTRL_F, CTRL_L, CTRL_A] = ["\x1b[1;2C", "\x1b[1;3A", "\x1b[D", "\x1f", "\x04", "\x06", "\x0c", "\x01"];

console.log("Editor, auto-save, undo/redo, problems");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await press(KEY.tab);
  await press(KEY.enter, 600);
  check("opens a file from the tree", frame().includes("const a = 1"));
  await press("e", 300);
  check("e opens the editor", frame().includes("EDITING"));
  await press(KEY.end);
  await type(" // hi");
  check("typing shows in the editor", frame().includes("// hi"));
  await delay(1600);
  check("auto-saves after a pause", readFileSync("a.ts", "utf-8").includes("// hi"));
  await press(KEY.ctrlZ, 200);
  check("Ctrl+Z undoes the typed word", !frame().includes("// hi"));
  await press(KEY.ctrlY, 200);
  check("Ctrl+Y redoes it", frame().includes("// hi"));
  await press(KEY.esc, 1500);
  check("Esc closes the editor", !frame().includes("EDITING"));
  await press(KEY.tab);
  await press(KEY.tab, 200);
  await press(KEY.down, 100);
  await press(KEY.enter, 2000);
  check("syntax errors are marked", frame().includes("Syntax error"));
  await press("p", 400);
  check("p shows the Problems panel", frame().includes("Problems") && frame().includes("b.ts"));
  await press("p", 200);
  await press("u", 200);
  check("u with nothing to undo says so", frame().includes("Nothing of Nou"));
  await press(KEY.esc, 150);
  await type("/diff");
  await press(KEY.enter, 600);
  check("/diff lists this session's changes", frame().includes("Changes in this session") && frame().includes("a.ts  +1 -1"));
  check("/diff opens the session diff", frame().includes("THIS SESSION"));
  await press(KEY.esc, 150); // closes the diff
  await press(KEY.esc, 150); // back to the chat
  await type("/sessions");
  await press(KEY.enter, 400);
  check("/sessions lists sessions", frame().includes("(this session)"));
  await press(KEY.ctrlC, 150);
  check("first Ctrl+C asks to press again", frame().includes("Press again to quit"));
  check("version is shown in the header", /NOU v\d+\.\d+\.\d+/.test(frame()));
});

console.log("Approvals and auto mode");
{
  let turn = 0;
  const writer: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat() {
      turn++;
      if (turn % 2 === 1) return { text: "Writing.", toolCalls: [{ id: `w${turn}`, name: "write_file", args: { path: `auto${turn}.txt`, content: "hi\n" } }] };
      return { text: "Done.", toolCalls: [] };
    },
  };
  await session({ provider: writer, model: "fake" }, async ({ press, type, frame }) => {
    await type("write a file");
    await press(KEY.enter, 1500);
    check("an edit waits for approval in the chat", frame().includes("Nou wants to create auto1.txt"));
    await press(KEY.tab, 100); // chat → files: the other panes keep working while it waits
    await press(KEY.down, 100);
    check("switching panes and moving around don't answer the approval", frame().includes("Nou wants to create auto1.txt") && !existsSync("auto1.txt"));
    await press("y", 1500);
    check("y from the file tree accepts it", existsSync("auto1.txt"));
    await press(KEY.shiftTab, 200);
    check("Shift+Tab switches to auto-edit mode", frame().includes("auto-edit") && frame().includes("Auto-edit mode"));
    await press(KEY.tab, 100);
    await press(KEY.tab, 100);
    await type("another");
    await press(KEY.enter, 1500);
    check("in auto-edit mode edits apply without asking", existsSync("auto3.txt") && !frame().includes("Nou wants to"));
    await type("/auto ask");
    await press(KEY.enter, 200);
    check("/auto ask goes back to asking", frame().includes("Ask mode"));
  });
  for (const f of ["auto1.txt", "auto3.txt"]) if (existsSync(f)) rmSync(f);
}

console.log("Agent edits: problem feedback, undo, rewind");
let call = 0;
const reports: string[] = [];
const fake: any = {
  id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
  async chat({ messages }: any) {
    call++;
    const last = messages[messages.length - 1];
    if (last.role === "tool") reports.push(last.content);
    if (call === 1) return { text: "Creating it.", toolCalls: [{ id: "c1", name: "write_file", args: { path: "c.ts", content: "function f( {\n  return 1;\n}\n" } }] };
    if (call === 2) return { text: "Fixing.", toolCalls: [{ id: "c2", name: "edit_file", args: { path: "c.ts", old_string: "function f( {", new_string: "function f() {" } }] };
    return { text: "Done.", toolCalls: [] };
  },
};
await session({ provider: fake, model: "fake" }, async ({ press, type, frame }) => {
  await type("make c.ts");
  await press(KEY.enter, 2500);
  check("proposed new file waits for approval", frame().includes("NEW FILE"));
  check("proposed edit is checked before approval", frame().includes("This edit adds problems"));
  await press("y", 2500);
  check("problems Nou introduced are reported back to the model", reports.some((r) => r.includes("introduced problems")));
  await press("y", 2500);
  check("the model's fix is applied", readFileSync("c.ts", "utf-8").startsWith("function f() {"));
  await press(KEY.tab, 100);
  await press("u", 400);
  check("u undoes Nou's last edit", readFileSync("c.ts", "utf-8").startsWith("function f( {"));
  await press(KEY.tab);
  await press(KEY.tab, 100);
  await type("/rewind");
  await press(KEY.enter, 600);
  check("/rewind removes the file Nou created", !existsSync("c.ts"));
  await type("/history");
  await press(KEY.enter, 400);
  check("/history lists changes", frame().includes("Recent changes"));
  await type("/version");
  await press(KEY.enter, 400);
  check("/version shows the version", /nou v\d+\.\d+\.\d+/.test(frame()));
});

console.log("Quitting and sideways scrolling");
await session(resolveModel("ollama"), async ({ press, frame }) => {
  await press(KEY.tab);
  await press("q", 150);
  check("a single q asks to press again instead of quitting", frame().includes("Press again to quit"));
  await delay(2200);
  await press(KEY.down);
  await press(KEY.down);
  await press(KEY.enter, 800);
  await press("e", 300);
  await press(KEY.end, 300);
  check("scrolled sideways, other lines scroll too", frame().includes("END1") && frame().includes("END2"));
  await press(KEY.esc, 300);
});

console.log("Mouse");
// SGR mouse reports, 1-based like a real terminal sends them. The test screen is 100 columns:
// files 0-23, code 24-65, chat 66-99. Pane rows start at y=3 (0-based) under the border and title.
const wheel = (dir: "up" | "down", x: number, y: number, shift = false) => `\x1b[<${(dir === "up" ? 64 : 65) + (shift ? 4 : 0)};${x + 1};${y + 1}M`;
const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  for (let i = 0; i < 4; i++) {
    await type("/help");
    await press(KEY.enter, 150);
  }
  await press(wheel("up", 80, 8), 200);
  await press(wheel("up", 80, 8), 200);
  check("wheel over the chat scrolls it back", frame().includes("scrolled"));
  check("mouse events don't leak into the chat input", !frame().includes("[<"));
  await press(wheel("down", 80, 8), 200);
  await press(wheel("down", 80, 8), 200);
  check("wheel down returns to the latest messages", !frame().includes("scrolled"));
  await press(click(5, 3 + 3), 800); // 4th row in the tree: many.ts
  check("clicking a file in the tree opens it", frame().includes("many.ts") && frame().includes("const line1 = 1;"));
  await press(wheel("down", 40, 10), 200);
  await press(wheel("down", 40, 10), 200);
  check("wheel over the code scrolls it", !frame().includes("const line1 = 1;") && frame().includes("const line7 = 7;"));
  // Where the code pane's top-left corner is (╭ when focused, ┌ otherwise).
  const codeLeft = () => frame().split("\n")[1]!.slice(1).search(/[╭┌]/) + 1;
  const before = codeLeft();
  await press(click(23, 10), 100);
  await press(`\x1b[<32;${33 + 1};11M`, 100); // drag the files/code border 10 columns right
  await press(`\x1b[<0;${33 + 1};11m`, 200);
  check("dragging the border between panes resizes them", before === 24 && codeLeft() === 34);
  await press(KEY.tab, 100); // to the file tree, so > and = aren't typed into the chat
  await press(KEY.tab, 100);
  await press(">", 200);
  check("> widens the focused pane", codeLeft() === 36);
  await press("=", 200);
  check("= puts the default widths back", codeLeft() === 24);
});

console.log("Scrolling");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/help");
  await press(KEY.enter, 200);
  await press(KEY.tab, 100); // files
  await press(click(5, 3 + 3), 800); // many.ts
  await press(wheel("down", 40, 10).repeat(5), 300);
  check("a burst of wheel events scrolls by all of them, in one go", frame().includes("16-") && frame().includes("const line16 = 16;") && !frame().includes("const line15 = 15;"));
  await press(wheel("down", 40, 10, true), 200);
  check("Shift+wheel scrolls sideways", frame().includes("→6") && !frame().includes("const line16"));
  await press("h", 100);
  await press(click(64, 21), 300); // the bottom of the code pane's scrollbar
  check("clicking the scrollbar jumps there", frame().includes("/100") && frame().includes("const line100 = 100;"));
  await press(`\x1b[<32;${64 + 1};${3 + 1}M`, 200); // drag it to the top
  await press(`\x1b[<0;${64 + 1};${3 + 1}m`, 100);
  check("dragging the scrollbar scrolls", frame().includes("const line1 = 1;"));
  await type("/help"); // from the code view: / goes to the chat's command box
  check("/ in the code view starts a command in the chat", frame().includes("❯ /help") && !frame().includes("EDITING"));
  await press(KEY.enter, 150);
  for (let i = 0; i < 2; i++) {
    await type("/help");
    await press(KEY.enter, 150);
  }
  await press(wheel("up", 80, 8), 200);
  await press(KEY.esc, 100);
  await type("/version");
  await press(KEY.enter, 300);
  check("scrolled up in the chat, new messages don't pull the view down", frame().includes("new lines below"));
});

console.log("Editing with the mouse and keyboard");
writeFileSync(path.join(dir, "edit.ts"), "function f() {\n  const alpha = 1;\n  const beta = 2;\n  return alpha;\n}\n// line50 marker\n");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/help");
  await press(KEY.enter, 200);
  await press(KEY.ctrlP, 200);
  await type("edit.ts");
  await press(KEY.enter, 800);
  // Code text starts after the border (x=24) and the 1-digit gutter plus marker: column 0 is x=27.
  await press(click(27 + 8, 3 + 1), 400); // line 2, column 9: "alpha"
  await press(`\x1b[<0;${27 + 8 + 1};${3 + 1 + 1}m`, 100);
  check("clicking in the code starts editing right there", frame().includes("EDITING") && frame().includes("Ln 2, Col 9"));
  await press(SHIFT_RIGHT);
  await press(SHIFT_RIGHT);
  await press(SHIFT_RIGHT, 150);
  check("Shift+arrows select", frame().includes("3 selected"));
  await type("ZZ");
  check("typing replaces the selection", frame().includes("const ZZha = 1;"));
  await press(KEY.ctrlZ, 200);
  check("undo brings the selection's text back", frame().includes("const alpha = 1;"));
  await press(`\x1b[<0;${27 + 8 + 1};${3 + 2 + 1}M`, 100); // press on line 3, column 9
  await press(`\x1b[<32;${27 + 12 + 1};${3 + 2 + 1}M`, 100); // drag 4 columns right
  await press(`\x1b[<0;${27 + 12 + 1};${3 + 2 + 1}m`, 200);
  check("dragging the mouse selects", frame().includes("4 selected") && frame().includes("Ln 3"));
  await press(KEY.esc, 100); // clears the selection, stays in the editor
  check("Esc with a selection only clears it", frame().includes("EDITING") && !frame().includes("selected"));
  await press(CTRL_SLASH, 200);
  check("Ctrl+/ comments the line", frame().includes("// const beta = 2;"));
  await press(CTRL_SLASH, 200);
  check("and again uncomments it", frame().includes("  const beta = 2;") && !frame().includes("// const beta"));
  await press(ALT_UP, 200);
  check("Alt+↑ moves the line up", /const beta = 2;[^\n]*\n[^\n]*const alpha = 1;/.test(frame()));
  await press(KEY.ctrlZ, 200);
  await press(CTRL_D, 200);
  check("Ctrl+D duplicates the line", (frame().match(/const beta = 2;/g) ?? []).length === 2);
  await press(KEY.ctrlZ, 200);
  await press(CTRL_F, 100);
  await type("line50");
  await press(KEY.enter, 200);
  check("Ctrl+F finds text", frame().includes("Find: line50") && frame().includes("edit.ts:6"));
  await press(KEY.esc, 100);
  await press(CTRL_L, 100);
  await type("4");
  await press(KEY.enter, 200);
  check("Ctrl+L goes to a line", frame().includes("edit.ts:4") && !frame().includes("Go to line"));
  await press(KEY.end);
  await press(KEY.enter, 100);
  await type("if (x) {}");
  await press(LEFT);
  await press(KEY.enter, 200);
  check("Enter between braces opens an indented line", /if \(x\) \{[^\n]*\n[^\n]*\d+ ▸ {4}[^\n]*\n[^\n]*\d+ {4}\}/.test(frame()));
  await press(CTRL_A, 100);
  check("Ctrl+A selects everything", /\d+ selected/.test(frame()));
  await press(KEY.ctrlC, 200);
  check("Ctrl+C with a selection copies instead of quitting", !frame().includes("Press again to quit") && /Copied|clipboard/.test(frame()));
  await press(KEY.esc, 100);
  await press(KEY.esc, 1500);
  check("Esc leaves the editor", !frame().includes("EDITING"));
});

console.log("Engines");
writeFakeEngines(process.env.NOU_ENGINE_DIR!);
writeFileSync(path.join(dir, "greet.js"), "export const greet = (name) => 'Hello ' + name;\n");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/engine");
  await press(KEY.enter, 300);
  check("/engine lists the engines", frame().includes("○ claude-code") && frame().includes("○ codex") && frame().includes("○ pi"));
  await type("/engine codex");
  await press(KEY.enter, 600);
  check("/engine switches engine and says it edits without asking", frame().includes("Now using the Codex engine") && frame().includes("Codex · Codex's default model"));
  await type("change the greeting");
  await press(KEY.enter, 1500);
  check("the Codex engine answers in the chat", frame().includes("Changed the greeting."));
  check("its edit is on disk and listed as Nou's", readFileSync(path.join(dir, "greet.js"), "utf-8").includes("Howdy"));
  await press(KEY.esc, 150);
  await type("/rewind");
  await press(KEY.enter, 600);
  check("/rewind undoes everything an external engine did in its turn", readFileSync(path.join(dir, "greet.js"), "utf-8").includes("Hello") && !existsSync(path.join(dir, "notes.md")));
  await type("/settings");
  await press(KEY.enter, 300);
  await press(KEY.tab, 300);
  check("Settings has an Engine tab showing the one in use", frame().includes("Claude Code") && /● Codex\s+in use/.test(frame()));
  await press(KEY.esc, 200);
  await type("/engine nou");
  await press(KEY.enter, 400);
  check("switching back to Nou's engine", frame().includes("Now using the Nou engine"));
});

console.log("Connecting a provider");
delete process.env.FIREWORKS_API_KEY;
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/connect fireworks");
  await press(KEY.enter, 300);
  check("/connect opens the provider's connect form", frame().includes("Connect Fireworks AI") && frame().includes("API key"));
  await type("fw-secret");
  check("the key is masked while typing", !frame().includes("fw-secret") && frame().includes("•••"));
  await press(KEY.enter, 400);
  check("the key is saved and applies without a restart", process.env.FIREWORKS_API_KEY === "fw-secret"
    && JSON.parse(readFileSync(path.join(process.env.HOME!, ".nou", "credentials.json"), "utf-8")).FIREWORKS_API_KEY === "fw-secret");
  check("then it moves on to picking a model", frame().includes("MODELS · Fireworks AI") && !frame().includes("Not set up"));
  await press(KEY.esc, 150);
  await press(KEY.esc, 150);
  await type("/connect nope");
  await press(KEY.enter, 300);
  check("/connect names the providers it knows", frame().includes("Unknown provider \"nope\"") && frame().includes("litellm"));
});
delete process.env.FIREWORKS_API_KEY;

console.log("Fixing a rejected key");
{
  // A gateway that only takes "good-key", like OpenAI answering 401 for a stale one.
  const { createServer } = await import("http");
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer good-key";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { object: "list", data: [{ id: "gateway-model", object: "model" }] } : { error: { message: "Incorrect API key provided" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  process.env.LITELLM_API_KEY = "stale-key";
  await session(resolveModel("litellm:gateway-model"), async ({ press, type, frame }) => {
    await type("/settings");
    await press(KEY.enter, 800);
    check("a rejected key says where it came from and how to fix it", frame().includes("401") && /LITELLM_API_KEY from your\s+environment was rejected/.test(frame()) && frame().includes("Press k"));
    await press("k", 300);
    await press(KEY.enter, 200); // keep the URL
    check("changing it warns that the environment wins on restart", frame().includes("is set (from your environment)") && /wins when Nou\s+restarts/.test(frame()));
    await type("good-key");
    await press(KEY.enter, 800);
    check("the new key works right away", process.env.LITELLM_API_KEY === "good-key" && frame().includes("gateway-model") && !frame().includes("rejected"));
  });
  server.close();
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
}

check(`fast output matches Ink's on all ${outputCompare.frames} frames`, outputCompare.frames > 100 && outputCompare.mismatches === 0);

process.chdir(os.tmpdir());
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
