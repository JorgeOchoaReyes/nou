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
process.env.NOU_TEST_OPEN = "1"; // web links are noted, not opened in a browser
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
/** Waits until `ok()` holds (up to `ms`), so a check doesn't race a slow machine; returns whether it does. */
const until = async (ok: () => boolean, ms = 5000) => {
  for (let waited = 0; waited < ms && !ok(); waited += 50) await delay(50);
  return ok();
};
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

console.log("Show me how");
{
  writeFileSync(path.join(dir, "guided.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  let calls = 0;
  const teacher: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat({ messages }: any) {
      calls++;
      const last = messages[messages.length - 1];
      if (last.role === "user") {
        return { text: "", toolCalls: [{ id: `g${calls}`, name: "show_steps", args: { steps: [
          { file: "guided.ts", line: 4, code: "export const double = (n: number) => add(n, n);", why: "A helper that reuses add." },
          { file: "guided.ts", line: 1, code: "// math helpers", why: "Say what the file is for." },
        ] } }] };
      }
      return { text: "Those are the steps.", toolCalls: [] };
    },
  };
  await session({ provider: teacher, model: "fake" }, async ({ press, type, frame }) => {
    await type("/showme add a double helper");
    await press(KEY.enter, 300);
    check("/showme opens the first step in the editor, saying why", await until(() => frame().includes("Step 1 of 2") && frame().includes("EDITING") && frame().includes("A helper that reuses add")));
    check("the code to type shows ahead of the cursor", await until(() => frame().includes("xport const double")));
    // The editor's on screen; End (harmless in either pane) lets it take the keyboard before typing: on a
    // loaded machine, React hooks up its key handler only when the next key arrives.
    await until(() => frame().split("\n").at(-1)!.includes("EDIT"));
    await press(KEY.end, 200);
    await type("export const dou");
    check("typing follows the dim text", await until(() => frame().includes("ble = (n: number)") && frame().includes("Type the dim text")));
    await press(KEY.tab, 300);
    check("Tab fills in the rest; the step is done, saved, and the next one opens", await until(() => frame().includes("Step 2 of 2") && readFileSync(path.join(dir, "guided.ts"), "utf-8").includes("double"))
      && readFileSync(path.join(dir, "guided.ts"), "utf-8").includes("export const double = (n: number) => add(n, n);"));
    await press(KEY.end, 200);
    await type("// math helperz");
    check("a typo is pointed out", await until(() => frame().includes("Not quite")));
    await press("\x7f", 100); // Backspace
    await until(() => !frame().includes("Not quite"));
    await type("s");
    check("fixing it finishes the guide", await until(() => frame().includes("That's it: all 2 steps")) && readFileSync(path.join(dir, "guided.ts"), "utf-8").startsWith("// math helpers\nexport function add"));
    check("Nou didn't edit anything itself", calls === 2);
  });
}

{
  // Engines that can't call Nou's tools give the steps in a nou-steps block at the end of their reply.
  writeFileSync(path.join(dir, "taught.ts"), "export const one = 1;\n");
  const blockTeacher: any = {
    id: "fake", label: "Fake", local: true, defaultModel: "fake", unavailable: () => null, listModels: async () => ["fake"],
    async chat() {
      return { text: 'Add it like this.\n```nou-steps\n[{"file": "taught.ts", "line": 2, "code": "export const two = 2;", "why": "The next number."}]\n```', toolCalls: [] };
    },
  };
  await session({ provider: blockTeacher, model: "fake" }, async ({ press, type, frame }) => {
    await type("/teach add two");
    await press(KEY.enter, 300);
    check("/teach reads steps from the reply's block, and hides the block", await until(() => frame().includes("Step 1 of 1") && frame().includes("The next number.")) && !frame().includes("nou-steps"));
  });
}

