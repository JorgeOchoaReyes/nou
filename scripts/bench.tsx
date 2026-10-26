/**
 * Rendering benchmark: drives the real app in a fake 200x50 terminal (the same interactive renderer
 * a user gets) and reports how long each interaction takes and how many bytes reach the terminal.
 * Run: npm run bench
 */
import { EventEmitter } from "events";
import { mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const dir = mkdtempSync(path.join(os.tmpdir(), "nou-bench-"));
for (let i = 0; i < 40; i++) writeFileSync(path.join(dir, `file${i}.ts`), Array.from({ length: 400 }, (_, j) => `export const value${j} = ${j} * ${i}; // a line of code`).join("\n"));
process.chdir(dir);
process.env.NOU_NO_UPDATE_CHECK = "1";
process.env.HOME = process.env.USERPROFILE = mkdtempSync(path.join(os.tmpdir(), "nou-bench-home-"));

await import("../src/env.js"); // as the app does: production React, before React loads
// Older checkouts don't have it; --no-fast-width compares against Ink's own.
if (!process.argv.includes("--no-fast-width")) await import("../src/ui/fast-width.js").then((m) => m.installFastWidth(), () => false);
const { render } = await import("ink");
const { createElement } = await import("react");
const { App } = await import("../src/ui/App.js");
const { resolveModel } = await import("../src/providers/index.js");
// Older checkouts (to compare against) have neither file.
const RENDER_OPTIONS = await import("../src/ui/render-options.js").then((m) => m.RENDER_OPTIONS, () => ({ alternateScreen: true, exitOnCtrlC: false }));
await import("../src/ui/fast-output.js").then((m) => m.installFastOutput(), () => false);

class Out extends EventEmitter {
  isTTY = true;
  columns = 200;
  rows = 50;
  bytes = 0;
  writes = 0;
  write = (s: string) => {
    this.bytes += Buffer.byteLength(s);
    this.writes++;
    return true;
  };
}
class In extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write(s: string) {
    this.data = s;
    this.emit("readable");
    this.emit("data", s);
  }
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

const stdout = new Out();
const stdin = new In();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A model that streams a long reply quickly, like a fast cloud model.
const reply = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: here is **some** text with \`code\` and a [link](https://example.com) that wraps across lines.`).join("\n\n");
const fake: any = {
  ...resolveModel("ollama").provider, id: "fake", local: false, unavailable: () => null,
  async chat({ onText }: any) {
    for (const word of reply.split(/(?<= )/)) {
      onText(word);
      await new Promise((r) => setTimeout(r, 2));
    }
    return { text: reply, toolCalls: [] };
  },
};
const app = render(createElement(App, { initialModel: { provider: fake, model: "m" }, permContext: "" }), {
  ...RENDER_OPTIONS, ...(process.argv.includes("--no-incremental") ? { incrementalRendering: false } : {}), stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, patchConsole: false, interactive: true,
});
await delay(1500);

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
async function measure(label: string, n: number, act: (i: number) => void) {
  if (only && !label.includes(only)) return;
  const b0 = stdout.bytes;
  const w0 = stdout.writes;
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < n; i++) {
    act(i);
    await delay(10);
  }
  await delay(300);
  const cpu = process.cpuUsage(cpu0);
  const ms = (cpu.user + cpu.system) / 1000;
  console.log(`${label.padEnd(34)} ${(ms / n).toFixed(2).padStart(7)} ms CPU/event  ${Math.round((stdout.bytes - b0) / n).toString().padStart(7)} bytes/event  ${((stdout.writes - w0) / n).toFixed(1)} writes/event`);
}

// Open a file and give the chat some history.
stdin.write("\x10"); // Ctrl+P
await delay(200);
for (const ch of "file3") stdin.write(ch);
await delay(200);
stdin.write("\r");
await delay(500);
stdin.write("\t"); // code -> chat
await delay(200);

// Warm up (the JIT compiles the hot paths), then clear the input.
for (let i = 0; i < 300; i++) {
  stdin.write("abcdefghij"[i % 10]!);
  if (i % 3 === 0) stdin.write(`\x1b[<${i % 20 < 10 ? 65 : 64};100;20M`);
  await delay(5);
}
stdin.write("\x15"); // Ctrl+U
await delay(300);

await measure("type in chat", 60, (i) => stdin.write("abcdefghij"[i % 10]!));
await measure("wheel over code view", 60, (i) => stdin.write(`\x1b[<${i % 20 < 10 ? 65 : 64};100;20M`));
await measure("wheel over file tree", 40, () => stdin.write("\x1b[<65;10;20M"));
await measure("wheel burst (10 per chunk)", 20, () => stdin.write("\x1b[<65;100;20M".repeat(10)));
stdin.write("\t"); // chat -> tree
stdin.write("\t"); // tree -> code
await delay(100);
stdin.write("e");
await delay(300);
await measure("type in editor", 60, (i) => stdin.write("abcdefghij"[i % 10]!));
await measure("arrow keys in editor", 60, (i) => stdin.write(i % 2 ? "\x1b[B" : "\x1b[A"));
stdin.write("\x1b"); // leave the editor
await delay(200);
stdin.write("\t"); // to chat
await delay(200);
if (!only || "stream".includes(only) || only.includes("stream")) {
// Some history first, then time one more streamed reply on top of it.
  for (let i = 0; i < 4; i++) {
    for (const ch of "hi") stdin.write(ch);
    stdin.write("\r");
    await delay(2500);
  }
  {
    const b0 = stdout.bytes;
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    for (const ch of "hi") stdin.write(ch);
    stdin.write("\r");
    await delay(2500);
    const cpu = process.cpuUsage(cpu0);
    console.log(`${"stream a reply (after 4 replies)".padEnd(34)} ${((cpu.user + cpu.system) / 1000).toFixed(0).padStart(7)} ms CPU total  ${Math.round((stdout.bytes - b0) / 1024).toString().padStart(6)} KB  (${Date.now() - t0} ms wall)`);
  }
}
app.unmount();
process.exit(0);
