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

const KEY = { tab: "\t", enter: "\r", esc: "\x1b", down: "\x1b[B", end: "\x1b[F", ctrlC: "\x03", ctrlZ: "\x1a", ctrlY: "\x19" };

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
const wheel = (dir: "up" | "down", x: number, y: number) => `\x1b[<${dir === "up" ? 64 : 65};${x + 1};${y + 1}M`;
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

process.chdir(os.tmpdir());
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
