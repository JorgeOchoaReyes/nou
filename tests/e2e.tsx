/**
 * End-to-end tests: drives the real app with simulated keypresses in a temporary project.
 * Run: npm test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

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
  check("while dragging, the status bar says so, with the widths", frame().split("\n").at(-1)!.includes("RESIZE") && frame().split("\n").at(-1)!.includes("files 34"));
  await press(`\x1b[<0;${33 + 1};11m`, 200);
  check("dragging the border between panes resizes them", before === 24 && codeLeft() === 34);
  await press(click(33, 10), 100); // grab it again and let go further right, with no movement reported in between
  await press(`\x1b[<0;${38 + 1};11m`, 200);
  check("a border lands where it's released even without drag reports", codeLeft() === 39 && !frame().includes("RESIZE"));
  await press(click(39 + 1, 1), 100); // on the top border row, a column further off still grabs it
  await press(`\x1b[<0;${36 + 1};2m`, 200);
  check("the top border row is an easier place to grab a border", codeLeft() === 37);
  await press(KEY.tab, 100); // to the file tree, so > and = aren't typed into the chat
  await press(KEY.tab, 100);
  await press(">", 200);
  check("> widens the focused pane", codeLeft() === 39);
  await press("=", 200);
  check("= puts the default widths back", codeLeft() === 24);
});

console.log("Scrolling");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/help");
  await press(KEY.enter, 200);
  await press(KEY.tab, 100); // files
  await press(click(5, 3 + 3), 800); // many.ts
  await press(wheel("down", 40, 10).repeat(5) + wheel("down", 40, 10, true), 100);
  // The scroll glides over a few frames: wait for it to land (slow machines take longer).
  for (let waited = 0; waited < 2000 && !frame().includes("16-"); waited += 50) await delay(50);
  check("a burst of wheel events scrolls by all of them, landing in the right place", frame().includes("16-") && frame().includes("const line16 = 16;") && !frame().includes("const line15 = 15;"));
  check("stray sideways steps while scrolling down are ignored (trackpads send them)", !/→\d/.test(frame()));
  await delay(200);
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
  const up = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
  await press(click(27 + 8, 3 + 1) + up(27 + 8, 3 + 1), 600); // line 2, column 9: "alpha"
  check("a single click in the code doesn't start editing", !frame().includes("EDITING"));
  await delay(600); // too slow for a double-click
  await press(click(27 + 8, 3 + 1) + up(27 + 8, 3 + 1), 50);
  await press(click(27 + 8, 3 + 1) + up(27 + 8, 3 + 1), 400);
  check("double-clicking in the code starts editing right there", frame().includes("EDITING") && frame().includes("Ln 2, Col 9"));
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
  await press(KEY.esc, 600);
  await press(click(27 + 9, 3 + 2) + up(27 + 9, 3 + 2), 50); // double-click inside "beta"
  await press(click(27 + 9, 3 + 2) + up(27 + 9, 3 + 2), 200);
  check("double-clicking in the editor selects the word", frame().includes("4 selected") && frame().includes("Ln 3, Col 13"));
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
  const quitPrompt = frame().includes("Press again to quit");
  // Copying runs the system clipboard tool, which can take a while (PowerShell on Windows).
  for (let i = 0; i < 40 && !/Copied|clipboard/.test(frame()); i++) await delay(100);
  check("Ctrl+C with a selection copies instead of quitting", !quitPrompt && /Copied|clipboard/.test(frame()));
  await press(KEY.esc, 100);
  await press(KEY.esc, 1500);
  check("Esc leaves the editor", !frame().includes("EDITING"));
});

console.log("Finding things: command menu, palette, clickable status bar");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/mo");
  check("typing / lists matching commands with what they do", frame().includes("/model") && frame().includes("/models") && frame().includes("show or switch"));
  await press(KEY.down, 100);
  await press(KEY.tab, 150);
  check("↓ then Tab completes the highlighted command", frame().includes("❯ /models ") && !frame().includes("EXPLORER"));
  await press("\x15", 100); // Ctrl+U clears the input
  await type("/ver");
  await press(KEY.enter, 300);
  check("Enter runs the highlighted command", /nou v\d+\.\d+\.\d+/.test(frame()));
  await type("/conn");
  await press(KEY.enter, 200);
  check("a command that needs an argument is completed, not run", frame().includes("❯ /connect ") && !frame().includes("Usage: /connect"));
  await press("\x15", 100);
  await press(KEY.tab, 150); // to the files
  await press("?", 300);
  check("? opens every action, with its key", frame().includes("Find a file") && frame().includes("Ctrl+P") && frame().includes("commands"));
  await type("follow");
  await press(KEY.enter, 300);
  check("running an action from the palette works", frame().includes("◉ follow"));
  const status = () => frame().split("\n").at(-1)!;
  const statusY = () => frame().split("\n").length - 1;
  await press(click(status().indexOf(" ask ") + 1, statusY()), 300);
  check("clicking the mode chip in the status bar switches it", status().includes("auto-edit"));
  await press(click(status().indexOf("follow"), statusY()), 300);
  check("clicking the follow chip toggles it", status().includes("○ follow"));
  await press(click(frame().split("\n")[0]!.length - 3, 0), 400);
  check("clicking the model in the header opens the model settings", frame().includes("Settings") && frame().includes("PROVIDER"));
  await press(KEY.esc, 200);
  await type("/auto ask");
  await press(KEY.enter, 200);
});

console.log("Recent files and going back");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await press(KEY.ctrlP, 200);
  await type("many.ts");
  await press(KEY.enter, 500);
  await press(KEY.ctrlP, 200);
  await type("long.ts");
  await press(KEY.enter, 500);
  await press(KEY.ctrlP, 300);
  const list = frame().split("\n").filter((l) => l.includes(".ts"));
  const first = list.findIndex((l) => l.includes("long.ts") && l.includes("recent"));
  const second = list.findIndex((l) => l.includes("many.ts") && l.includes("recent"));
  check("Ctrl+P lists the files you opened first, latest first, marked recent", first >= 0 && second > first);
  await press(KEY.esc, 200);
  await press("b", 400);
  check("b goes back to the previous file", frame().includes("many.ts ×") && frame().includes("const line1 = 1;"));
  await press("b", 400);
  check("pressing b again flips back", frame().includes("long.ts"));
  check("the header stays on one line", frame().split("\n")[1]!.startsWith("┌") || frame().split("\n")[1]!.startsWith("╭"));
});

console.log("Finding things for you: open_file and clickable paths");
{
  let asked = 0;
  const finder: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat({ messages }: any) {
      asked++;
      const last = messages[messages.length - 1];
      if (last.role === "user") return { text: "", toolCalls: [{ id: `o${asked}`, name: "open_file", args: { path: "many.ts", line: 40, end_line: 42 } }] };
      return { text: "It's in many.ts:40-42, and a.ts has the other one.", toolCalls: [] };
    },
  };
  await session({ provider: finder, model: "fake" }, async ({ press, type, frame }) => {
    await type("where is line40 defined?");
    await press(KEY.enter, 1500);
    check("Nou opens what it found in the code view, at the line", frame().includes("many.ts  ") && frame().includes("const line40 = 40;"));
    const found = frame().split("\n").filter((l) => /▌.*const line4[012] =/.test(l));
    check("and highlights the lines it found", found.length === 3);
    check("the chat says what it opened", frame().includes("Opened many.ts:40-42"));
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => l.includes("a.ts has"));
    const x = rows[y]!.indexOf("a.ts has");
    await press(click(x + 1, y), 500);
    check("clicking a file named in a reply opens it", frame().split("\n")[2]!.includes(" a.ts"));
    await type("/open long");
    await press(KEY.enter, 400);
    check("/open opens a file from part of its name", frame().split("\n")[2]!.includes("long.ts"));
    writeFileSync(path.join(dir, "imp.ts"), 'import { a } from "./a.js";\nconsole.log(a);\n');
    await type("/open imp.ts");
    await press(KEY.enter, 400);
    // Code text starts after the border (x=24) and the 1-digit gutter plus marker: column 0 is x=27.
    const ctrlClick = (x: number, y: number) => `\x1b[<16;${x + 1};${y + 1}M`;
    await press(ctrlClick(27 + 12, 4), 400); // the "a" in console.log(a)
    check("Ctrl+click on an imported name jumps to its import line", /1▌import \{ a \}/.test(frame()));
    await press(ctrlClick(27 + 20, 3), 400); // the path in the import
    check("Ctrl+click on the import's path opens that file", frame().split("\n")[2]!.includes(" a.ts"));
    await press(`\x1b[<2;${27 + 6 + 1};${3 + 1}M`, 400); // right-click the "a" of const a = 1
    check("right-click goes to definitions too", frame().includes("1▌const a = 1;"));
  });
}

console.log("Tabs");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  for (const f of ["a.ts", "b.ts"]) {
    await type(`/open ${f}`);
    await press(KEY.enter, 300);
  }
  const title = () => frame().split("\n")[2]!;
  check("open files show as tabs over the code, each with a ×", title().includes("◆ a.ts × │") && title().includes("◆ b.ts × │"));
  const at = title().indexOf("◆ a.ts");
  await press(click(at, 2), 300);
  check("clicking a tab switches to it", title().includes("◆ a.ts × │") && frame().includes("const a = 1;"));
  await press(KEY.tab, 100);
  await press(KEY.tab, 100); // to the code
  await press("]", 300);
  check("] goes to the next tab", title().includes("◆ b.ts ×"));
  await press(click(title().indexOf("×", title().indexOf("b.ts")), 2), 300);
  check("clicking × closes the tab", !title().includes("b.ts") && frame().includes("const a = 1;"));
  await type("/open b.ts");
  await press(KEY.enter, 300);
  await press(click(title().indexOf("×", title().indexOf("a.ts")), 2), 300);
  check("any tab's × closes it, not just the current one's", !title().includes("a.ts") && title().includes("b.ts ×"));
  await press("\x17", 300); // Ctrl+W
  check("Ctrl+W closes the current tab", frame().includes("Welcome"));
  await type("/open a.ts");
  await press(KEY.enter, 300);
  check("a single open file has its tab too", title().includes("◆ a.ts ×"));
  await press(click(title().indexOf("a.ts"), 2), 200); // a click on a tab puts the keyboard in the code
  await press("x", 300);
  check("x closes the last one, back to the welcome screen", frame().includes("Welcome"));
});

console.log("Queueing and interrupting");
{
  const heard: string[] = [];
  const slow: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat({ messages, signal }: any) {
      const last = messages[messages.length - 1];
      heard.push(typeof last.content === "string" ? last.content.replace(/<editor_context>[\s\S]*/, "").trim() : "");
      await new Promise((r, reject) => {
        // "later" is the turn the test interrupts: long enough that "never" is always typed while it runs.
        const t = setTimeout(r, heard.at(-1) === "later" ? 8000 : 800);
        signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
      });
      return { text: `ok ${heard.length}`, toolCalls: [] };
    },
  };
  await session({ provider: slow, model: "fake" }, async ({ press, type, frame }) => {
    await type("first");
    await press(KEY.enter, 200);
    await type("second");
    await press(KEY.enter, 100);
    for (let waited = 0; waited < 1500 && !frame().includes("⏳ next: second"); waited += 50) await delay(50);
    check("a message sent while Nou works waits its turn, shown as next", frame().includes("⏳ next: second"));
    await delay(1800);
    check("and goes when Nou finishes", heard.includes("second") && !frame().includes("⏳ next"));
    await type("third");
    await press(KEY.enter, 200);
    await type("urgent");
    await press("\x1b\r", 1200);
    check("Alt+Enter stops Nou and sends right away", heard.at(-1) === "urgent" && frame().includes("Cancelled"));
    // Each step waits for the state it needs (slow machines take longer than any fixed delay).
    const status = () => frame().split("\n").at(-1)!;
    const until = async (ok: () => boolean, ms = 5000) => {
      for (let waited = 0; waited < ms && !ok(); waited += 50) await delay(50);
    };
    await until(() => !status().includes("WORKING"));
    await type("later");
    await press(KEY.enter, 100);
    await until(() => status().includes("WORKING") && heard.at(-1) === "later");
    await type("never");
    await press(KEY.enter, 100);
    await until(() => frame().includes("⏳ next: never"));
    await press(KEY.esc, 100);
    await until(() => frame().includes("❯ never"), 3000);
    const ok = !heard.includes("never") && frame().includes("❯ never");
    if (!ok) console.log(frame());
    check("Esc stops Nou and puts what was queued back in the input", ok);
  });
}

console.log("Find in the open file");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/open many.ts");
  await press(KEY.enter, 400);
  await press(KEY.tab, 100);
  await press(KEY.tab, 100); // to the code
  await press(CTRL_F, 200);
  check("Ctrl+F in the code opens a find bar", frame().includes("⌕") && frame().includes("type to find"));
  await type("line9");
  check("it counts the matches as you type", frame().includes("1/11"));
  await press(KEY.enter, 200);
  await press(KEY.enter, 200);
  check("Enter goes to the next match, scrolling to it", frame().includes("3/11") && frame().includes("1 = 91;"));
  await press("\x1b[A", 200);
  check("↑ goes back one", frame().includes("2/11"));
  check("letters go to the find bar, not to shortcuts", !frame().includes("EDITING"));
  await press(KEY.esc, 200);
  check("Esc closes it and stays in the code", !frame().includes("⌕") && frame().split("\n").at(-1)!.includes("CODE"));
});

console.log("Follow along");
{
  let step = 0;
  const reader: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat() {
      step++;
      if (step === 1) return { text: "", toolCalls: [
        { id: "r1", name: "read_file", args: { path: "a.ts" } },
        { id: "r2", name: "read_file", args: { path: "many.ts", offset: 50, limit: 3 } },
        { id: "r3", name: "read_file", args: { path: "b.ts" } },
      ] };
      return { text: "Read them.", toolCalls: [] };
    },
  };
  await session({ provider: reader, model: "fake" }, async ({ press, type, frame }) => {
    await press(KEY.tab, 100); // files
    await press("f", 100);
    await press(KEY.tab, 100);
    await press(KEY.tab, 100); // back to the chat
    await type("read things");
    await press(KEY.enter, 500);
    const title = () => frame().split("\n")[2]!;
    check("follow mode shows what Nou reads a step at a time, saying how far behind it is", title().includes("a.ts") && /◉ follow ·2/.test(frame()));
    await delay(1300);
    check("the next step shows the lines it read, highlighted", title().includes("many.ts") && /50▌.*const line50/.test(frame().replace(/\x1b\[[\d;]*m/g, "")));
    await delay(1300);
    check("and so on, until it has caught up", title().includes("b.ts") && !/follow ·\d/.test(frame()));
  });
}

console.log("Games");
await session(resolveModel("ollama"), async ({ press, type, frame }) => {
  await type("/settings");
  await press(KEY.enter, 300);
  for (let i = 0; i < 4; i++) await press(KEY.tab, 150);
  check("settings has a Games tab to get them from", frame().includes("Pong") && frame().includes("⬇ GET"));
  await press(KEY.enter, 200);
  check("Enter adds a game", frame().includes("✓ ADDED"));
  await press(KEY.esc, 300);
  await type("/games");
  await press(KEY.enter, 400);
  check("/games opens the Games panel with what you added", frame().includes("✦ Games") && frame().includes("▸ Pong"));
  await press(KEY.enter, 400);
  check("Enter starts the game", frame().includes("✦ Pong") && frame().includes("you 0 · 0 computer"));
  check("the panel has the keyboard", frame().split("\n").at(-1)!.includes("GAME"));
  const rows = frame().split("\n");
  const y = rows.findIndex((l) => l.includes("✦ Pong"));
  const x = rows[y]!.indexOf("✦ Pong");
  check("it docks under the chat, splitting its column", x > 66 && y > 3 && rows.slice(0, y).some((l) => l.slice(66).includes("┘")));
  await press(click(x, y), 100);
  await press(`\x1b[<32;${40 + 1};${y + 1}M`, 100);
  check("dragging it says where it can go", frame().includes("Drop it on a pane"));
  await press(`\x1b[<0;${40 + 1};${y + 1}m`, 300);
  const after = frame().split("\n");
  const moved = after.findIndex((l) => l.includes("✦ Pong"));
  check("letting go over the code docks it under the code", moved > 3 && after[moved]!.indexOf("✦ Pong") > 24 && after[moved]!.indexOf("✦ Pong") < 66);
  await press(KEY.esc, 300);
  check("Esc gives the keyboard back, and the game waits", !frame().split("\n").at(-1)!.includes("GAME") && frame().includes("click to play"));
  await type("/games");
  await press(KEY.enter, 300);
  check("/games again closes it", !frame().includes("✦ Pong"));
  await type("/games");
  await press(KEY.enter, 400);
  const open = frame().split("\n");
  const ty = open.findIndex((l) => l.includes("✦ Pong") || l.includes("✦ Games"));
  check("it opens where you left it", ty > 3 && open[ty]!.indexOf("✦") > 24 && open[ty]!.indexOf("✦") < 66);
  await press(click(open[ty]!.indexOf("×"), ty), 300);
  check("× at its top right closes it", !frame().includes("✦ Pong") && !frame().includes("✦ Games"));
});

console.log("MCP servers");
{
  const home = process.env.HOME!;
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");
  writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [server] } } }));
  await session(resolveModel("ollama"), async ({ press, type, frame }) => {
    await delay(800);
    check("MCP servers from your other tools are offered", frame().includes("Found 1 MCP server") && frame().includes("/mcp"));
    await type("/mcp import");
    await press(KEY.enter, 4000);
    const ok = readFileSync(path.join(home, ".nou", "mcp.json"), "utf-8").includes("mcp-server.mjs") && /● test\s+2\b/.test(frame());
    if (!ok) console.log(frame());
    check("/mcp import brings them over and connects", ok);
    check("the server's log never reaches the screen", !frame().includes("noisy server log line"));
  });
  rmSync(path.join(home, ".cursor"), { recursive: true, force: true });
  rmSync(path.join(home, ".nou", "mcp.json"), { force: true });
}

console.log("Taking back a message");
{
  let replies = 0;
  const model: any = { id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat() {
      replies++;
      return { text: `reply ${replies}`, toolCalls: [] };
    } };
  await session({ provider: model, model: "fake" }, async ({ press, type, frame }) => {
    await type("make it blue");
    await press(KEY.enter, 600);
    check("(the reply arrives)", frame().includes("reply 1"));
    const rows = frame().split("\n");
    const y = rows.findIndex((l) => l.includes("reply 1"));
    const x = rows[y]!.indexOf("reply 1");
    await press(click(x, y), 50);
    await press(`\x1b[<32;${x + 6 + 1};${y + 1}M`, 50);
    await press(`\x1b[<0;${x + 6 + 1};${y + 1}m`, 400);
    check("dragging over the chat selects and copies it", /Copied it ✓|Can't copy/.test(frame()));
    await type("/cancel");
    await press(KEY.enter, 600);
    check("/cancel takes back the last message and its reply, putting it in the input to edit", !frame().includes("reply 1") && frame().includes("❯ make it blue") && frame().includes("Took back"));
  });
}

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
  check("Codex reconnecting on the way isn't an error", !frame().includes("Reconnecting"));
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
  check("switching engines hands over the conversation so far", frame().includes("It has the conversation so"));
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
  process.env.LITELLM_API_KEY = "stale-key";
  await session(resolveModel("litellm:gateway-model"), async ({ press, type, frame }) => {
    await type("hello");
    await press(KEY.enter, 1500);
    check("a message that fails on a rejected key opens the provider's key form, saying why", frame().includes("Connect LiteLLM") && frame().includes("✖") && frame().includes("401"));
    await press(KEY.esc, 300);
    await press(KEY.esc, 300);
    check("Esc comes back to the chat, which says what happened", frame().includes("Opened its") && frame().includes("◆ Chat"));
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
