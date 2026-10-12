import type { AgentHooks } from "../agent/index.js";
import { toRelative } from "../commands/index.js";
import type { ModelChoice } from "../providers/index.js";
import { ExternalEngine, replaceIn } from "./external.js";
import { loadPackage } from "./index.js";
import { readFileSync } from "fs";
import path from "path";

/** Nou provider id -> pi's id for the same service, where pi has it built in. */
const PI_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  openrouter: "openrouter",
  groq: "groq",
  deepseek: "deepseek",
};

const THINKING: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/** The file's content after a pi edit or write, or undefined if it can't be worked out in advance. */
export function piProposedContent(tool: string, input: Record<string, any>): string | undefined {
  if (tool === "write") return String(input.content ?? "");
  let text: string | null;
  try {
    text = readFileSync(path.resolve(process.cwd(), input.path), "utf-8");
  } catch {
    return undefined;
  }
  // pi matches every oldText against the original file, so apply them to it one at a time.
  for (const edit of Array.isArray(input.edits) ? input.edits : []) text = text === null ? null : replaceIn(text, edit.oldText, edit.newText);
  return text ?? undefined;
}

/**
 * pi through its SDK, with the model picked in Nou (pi's built-in provider when it has one, otherwise
 * Nou's endpoint for it, e.g. Ollama). An inline extension sends pi's edits and commands to Nou's approval.
 */
export class PiEngine extends ExternalEngine {
  readonly id = "pi" as const;
  private piSession: any = null;

  constructor(choice: ModelChoice, hooks: AgentHooks) {
    super(choice, hooks, "pi");
  }

  protected resetConversation() {
    this.piSession?.dispose();
    this.piSession = null;
  }

  dispose() {
    this.resetConversation();
  }

  /** The pi model for Nou's current choice. */
  private async model(pi: any, runtime: any): Promise<any> {
    const { provider, model } = this.choice;
    const builtIn = PI_PROVIDERS[provider.id] && runtime.getModel(PI_PROVIDERS[provider.id], model);
    if (builtIn) return builtIn;
    const endpoint = provider.endpoint?.();
    if (!endpoint) throw new Error(`pi can't use ${provider.label}`);
    const id = `nou-${provider.id}`;
    runtime.registerProvider(id, {
      baseUrl: endpoint.baseURL,
      apiKey: endpoint.apiKey || "none",
      api: endpoint.api,
      // pi needs the full model description; these are safe defaults for a model it doesn't know.
      models: [{
        id: model, name: model, input: ["text"], reasoning: false, contextWindow: 32_768, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const found = runtime.getModel(id, model);
    if (!found) throw new Error(`pi couldn't set up ${provider.id}:${model}`);
    return found;
  }

  private async start(): Promise<any> {
    const pi = await loadPackage("@earendil-works/pi-coding-agent");
    const runtime = await pi.ModelRuntime.create();
    const cwd = process.cwd();
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: pi.getAgentDir(),
      appendSystemPromptOverride: (base: string[]) => [...base, ...this.extras],
      extensionFactories: [(api: any) => this.connect(api)],
    });
    await loader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      model: await this.model(pi, runtime),
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      ...(this.effort && THINKING[this.effort] ? { thinkingLevel: THINKING[this.effort] } : {}),
    });
    return session;
  }

  /** Nou's approvals, undo and problem checks, as a pi extension. */
  private connect(api: any) {
    api.on("tool_call", async (event: any) => {
      const input = event.input ?? {};
      if ((event.toolName === "edit" || event.toolName === "write") && input.path) {
        const ok = await this.tracker.approve(input.path, piProposedContent(event.toolName, input), event.toolName);
        return ok ? undefined : { block: true, reason: "The user rejected this change. Ask them what they would like instead." };
      }
      if (event.toolName === "bash" || event.toolName === "powershell") {
        const ok = await this.hooks.approve({ kind: "command", command: String(input.command ?? "") });
        if (!ok) this.hooks.onEntry({ kind: "tool", text: `Denied: ${input.command}` });
        return ok ? undefined : { block: true, reason: "The user denied permission to run this command." };
      }
      if (["read", "grep", "find", "ls"].includes(event.toolName)) return undefined;
      // Tools from pi extensions or packages: ask, like Nou's own plugin tools.
      const ok = await this.hooks.approve({ kind: "tool", name: event.toolName, args: input });
      return ok ? undefined : { block: true, reason: "The user denied this." };
    });
    api.on("tool_result", async (event: any) => {
      const input = event.input ?? {};
      if ((event.toolName === "edit" || event.toolName === "write") && input.path) {
        const problems = await this.tracker.applied(input.path);
        if (problems) return { content: [...event.content, { type: "text", text: `\n\nThis edit introduced problems; fix them:\n${problems}` }] };
        return undefined;
      }
      if (event.toolName === "read" && input.path) this.hooks.onRead(toRelative(input.path));
      const target = input.command ?? input.path ?? input.pattern ?? "";
      this.hooks.onEntry({ kind: "tool", text: event.toolName === "bash" || event.toolName === "powershell" ? `Ran: ${target}` : `${event.toolName} ${target}`.trim() });
      return undefined;
    });
  }

  protected async run(prompt: string, signal: AbortSignal) {
    this.piSession ??= await this.start();
    const session = this.piSession;
    let streamed = "";
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
        this.hooks.onStream(streamed);
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        streamed = "";
        this.hooks.onStream("");
        const text = (event.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
        if (text) this.hooks.onEntry({ kind: "assistant", text });
        if (event.message.stopReason === "error" && !signal.aborted) this.hooks.onEntry({ kind: "error", text: `pi: ${event.message.errorMessage ?? "the request failed"}` });
      }
    });
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort);
    try {
      await session.prompt(prompt);
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    if (signal.aborted) throw new Error("aborted");
  }
}
