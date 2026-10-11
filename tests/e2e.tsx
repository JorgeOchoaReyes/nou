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
process.chdir(dir);
process.env.NOU_NO_UPDATE_CHECK = "1";
// Keep test runs out of the real ~/.nou (history, settings).
process.env.HOME = process.env.USERPROFILE = mkdtempSync(path.join(os.tmpdir(), "nou-home-"));

// Imported after chdir: some modules read the working directory when loaded.
const { render } = await import("ink-testing-library");
const { createElement } = await import("react");
const { App } = await import("../src/ui/App.js");
const { resolveModel } = await import("../src/providers/index.js");

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
  await press(KEY.ctrlC, 150);
  check("first Ctrl+C asks to press again", frame().includes("Press Ctrl+C again"));
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
});

process.chdir(os.tmpdir());
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
