/**
 * Stand-ins for the Claude Agent SDK, Codex SDK and pi packages, so the engine adapters can be tested
 * without installing them or calling a model. Each one makes a scripted edit to greet.js the way the
 * real agent would (asking through its hooks first, where it has them) and records what Nou passed it
 * in globalThis.__engines.
 */
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const CLAUDE = `
import { readFileSync, writeFileSync } from "fs";
export function query({ prompt, options }) {
  const log = (globalThis.__engines ??= {}).claude ??= { calls: [] };
  log.calls.push({ prompt, options });
  const pre = options.hooks.PreToolUse[0].hooks[0];
  const post = options.hooks.PostToolUse[0].hooks[0];
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: "claude-session-1" };
    const input = { file_path: "greet.js", old_string: "Hello", new_string: "Hi" };
    const decision = await pre({ tool_name: "Edit", tool_input: input }, "t1", {});
    log.decision = decision.hookSpecificOutput?.permissionDecision;
    if (log.decision === "allow") {
      writeFileSync("greet.js", readFileSync("greet.js", "utf-8").replace("Hello", "Hi"));
      log.post = await post({ tool_name: "Edit", tool_input: input }, "t1", {});
    }
    const command = await pre({ tool_name: "Bash", tool_input: { command: "npm test" } }, "t2", {});
    log.command = command.hookSpecificOutput?.permissionDecision;
    log.read = await pre({ tool_name: "Read", tool_input: { file_path: "greet.js" } }, "t3", {});
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Do" } } };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Done." }] } };
    yield { type: "result", subtype: "success", is_error: false, session_id: "claude-session-1" };
  })();
}
`;

const CODEX = `
import { readFileSync, writeFileSync } from "fs";
export class Codex {
  startThread(options) {
    const log = (globalThis.__engines ??= {}).codex ??= { threads: [], inputs: [] };
    log.threads.push(options);
    return {
      async runStreamed(input) {
        log.inputs.push(input);
        return { events: (async function* () {
          yield { type: "item.started", item: { type: "command_execution", command: "ls" } };
          yield { type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } };
          writeFileSync("greet.js", readFileSync("greet.js", "utf-8").replace("Hello", "Howdy"));
          writeFileSync("notes.md", "# Notes\\n");
          yield { type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: "greet.js", kind: "update" }, { path: "notes.md", kind: "add" }] } };
          yield { type: "item.completed", item: { type: "agent_message", text: "Changed the greeting." } };
          yield { type: "turn.completed", usage: {} };
        })() };
      },
    };
  }
}
`;

const PI = `
import { readFileSync, writeFileSync } from "fs";
const log = () => ((globalThis.__engines ??= {}).pi ??= { registered: [] });
export const getAgentDir = () => "agent-dir";
export const SessionManager = { inMemory: () => ({}) };
export class DefaultResourceLoader {
  constructor(options) { this.options = options; }
  async reload() {}
}
export const ModelRuntime = {
  async create() {
    const models = new Map([["anthropic/claude-opus-5-5", { provider: "anthropic", id: "claude-opus-5-5" }]]);
    return {
      getModel: (provider, id) => models.get(provider + "/" + id),
      registerProvider(id, config) {
        log().registered.push({ id, config });
        for (const m of config.models) models.set(id + "/" + m.id, { ...m, provider: id });
      },
    };
  },
};
export async function createAgentSession(options) {
  const handlers = {};
  for (const factory of options.resourceLoader.options.extensionFactories) factory({ on: (event, fn) => (handlers[event] = fn) });
  log().model = options.model;
  log().system = options.resourceLoader.options.appendSystemPromptOverride(["base"]);
  const listeners = new Set();
  const emit = (event) => listeners.forEach((l) => l(event));
  return { session: {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text) {
      log().prompt = text;
      const input = { path: "greet.js", edits: [{ oldText: "Hello", newText: "Hey" }] };
      const call = await handlers.tool_call({ toolName: "edit", input, toolCallId: "1" });
      if (call?.block) log().blocked = call.reason;
      else {
        writeFileSync("greet.js", readFileSync("greet.js", "utf-8").replace("Hello", "Hey"));
        log().result = await handlers.tool_result({ toolName: "edit", input, content: [{ type: "text", text: "ok" }], isError: false });
      }
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Do" } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
    },
    async abort() {},
    dispose() { log().disposed = true; },
  } };
}
`;

export function writeFakeEngines(dir: string) {
  const write = (pkg: string, source: string) => {
    const pkgDir = path.join(dir, "node_modules", ...pkg.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, type: "module", exports: { ".": { import: "./index.mjs" } } }));
    writeFileSync(path.join(pkgDir, "index.mjs"), source);
  };
  write("@anthropic-ai/claude-agent-sdk", CLAUDE);
  write("@openai/codex-sdk", CODEX);
  write("@earendil-works/pi-coding-agent", PI);
}
