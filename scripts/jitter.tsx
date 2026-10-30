// scratch: count full-screen clears and frame heights while a reply streams with follow mode on
import { EventEmitter } from "events";
import { mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
const dir = mkdtempSync(path.join(os.tmpdir(), "nou-jit-"));
for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `file${i}.ts`), Array.from({ length: 200 }, (_, j) => `export const v${j} = ${j}; // line`).join("\n"));
process.chdir(dir);
process.env.NOU_NO_UPDATE_CHECK = "1";
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "nou-jit-home-"));
await import("../src/env.js");
const { render } = await import("ink");
const { createElement } = await import("react");
const { App } = await import("../src/ui/App.js");
const { resolveModel } = await import("../src/providers/index.js");
const { RENDER_OPTIONS } = await import("../src/ui/render-options.js");
const ROWS = Number(process.env.ROWS ?? 40), COLS = Number(process.env.COLS ?? 120);
class Out extends EventEmitter { isTTY = true; columns = COLS; rows = ROWS; clears = 0; frames = 0; write = (s: string) => { this.frames++; if (s.includes("\x1b[1;1H\x1b[J")) this.clears++; return true; }; }
class In extends EventEmitter { isTTY = true; data: string | null = null; write(s: string) { this.data = s; this.emit("readable"); this.emit("data", s); } read = () => { const d = this.data; this.data = null; return d; }; setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {} }
const stdout = new Out(); const stdin = new In();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const reply = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: **bold** and \`code\` text that wraps across a few lines of the chat pane.`).join("\n\n");
const fake: any = { ...resolveModel("ollama").provider, id: "fake", local: false, unavailable: () => null,
  async chat({ onText }: any) {
    step++;
    if (step <= 3) return { text: "", toolCalls: [{ id: `r${step}`, name: "read_file", args: { path: `file${step}.ts`, offset: 20, limit: 10 } }] };
    for (const w of reply.split(/(?<= )/)) { onText(w); await delay(3); }
    return { text: reply, toolCalls: [] };
  } };
const app = render(createElement(App, { initialModel: { provider: fake, model: "m" }, permContext: "" }), { ...RENDER_OPTIONS, stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, patchConsole: false, interactive: true });
await delay(1200);
stdin.write("\t"); await delay(100); stdin.write("f"); await delay(100); stdin.write("\t"); stdin.write("\t"); await delay(200);
const c0 = stdout.clears, f0 = stdout.frames;
for (const ch of "go") { stdin.write(ch); await delay(30); }
stdin.write("\r");
await delay(6000);
console.log(`frames written: ${stdout.frames - f0}, full-screen clears: ${stdout.clears - c0}`);
app.unmount(); process.exit(0);
