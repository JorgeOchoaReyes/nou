import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall } from "./types.js";

type Params = Anthropic.Beta.Messages.BetaMessageParam;
type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

// Models that accept server-side refusal fallbacks in their "default" form.
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
// Current-generation models take output_config.effort.
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5/;
const MAX_JSON_RETRIES = 2;

function toAnthropic(messages: ChatMessage[]): Params[] {
  const out: Params[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // Replay Claude's own turn unchanged (keeps thinking blocks valid); rebuild turns from other providers.
      const content = m.raw?.provider === "anthropic"
        ? (m.raw.data as Block[])
        : [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
        ];
      out.push({ role: "assistant", content });
    } else {
      const result: Block = { type: "tool_result", tool_use_id: m.callId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      // All results for one turn go back in a single user message.
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    }
  }
  return out;
}

/**
 * Marks the end of the conversation for prompt caching, so the next request (every tool step of a turn)
 * reads all of it from the cache instead of paying for it again: cached input costs a tenth or less.
 */
function withCacheBreakpoint(params: Params[]): Params[] {
  const last = params[params.length - 1];
  if (!last) return params;
  const content: Block[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content as Block[])];
  const end = content[content.length - 1];
  if (!end || end.type === "thinking" || end.type === "redacted_thinking") return params;
  content[content.length - 1] = { ...end, cache_control: { type: "ephemeral" } } as Block;
  return [...params.slice(0, -1), { ...last, content }];
}

function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE)
    || existsSync(path.join(os.homedir(), ".config", "anthropic"));
}

export function anthropicProvider(): Provider {
  // Rebuilt when the key or URL changes (they can be entered while Nou runs).
  let client: { auth: string; api: Anthropic } | null = null;
  const getClient = () => {
    const auth = `${process.env.ANTHROPIC_API_KEY}|${process.env.ANTHROPIC_AUTH_TOKEN}|${process.env.ANTHROPIC_BASE_URL}`;
    if (client?.auth !== auth) client = { auth, api: new Anthropic() };
    return client.api;
  };

  return {
    id: "anthropic",
    label: "Anthropic (Claude)",
    local: false,
    defaultModel: "claude-opus-5-5",
    connect: [
      { env: "ANTHROPIC_API_KEY", label: "API key", secret: true, placeholder: "console.anthropic.com/settings/keys" },
      { env: "ANTHROPIC_BASE_URL", label: "Base URL", optional: true, placeholder: "https://api.anthropic.com" },
    ],
    unavailable: () => (hasCredentials() ? null : "set ANTHROPIC_API_KEY (or run `ant auth login`)"),
    endpoint: () => ({
      baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
      api: "anthropic-messages" as const,
    }),

    async chat({ model, system, messages, tools, onText, signal, effort: requested }: ChatRequest): Promise<ChatResult> {
      const fallbacks = FALLBACK_MODELS.test(model);
      const effort = EFFORT_MODELS.test(model) ? process.env.NOU_EFFORT ?? requested ?? "high" : undefined;
      const body: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model,
        max_tokens: 64000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: withCacheBreakpoint(toAnthropic(messages)),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
          eager_input_streaming: true,
        })),
        stream: true,
        ...(effort ? { output_config: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
        ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      };

      for (let attempt = 0; ; attempt++) {
        let text = "";
        try {
          const stream = getClient().beta.messages.stream(body, signal ? { signal } : {});
          stream.on("text", (delta) => {
            text += delta;
            onText(delta);
          });
          const message = await stream.finalMessage();

          const toolCalls: ToolCall[] = message.content
            .filter((b) => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, any> }));
          const stop = message.stop_reason === "refusal"
            ? "refusal" as const
            : message.stop_reason === "max_tokens" && toolCalls.length ? "max_tokens" as const : undefined;
          return {
            text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
            toolCalls,
            raw: { provider: "anthropic", data: message.content },
            ...(stop ? { stop } : {}),
          };
        } catch (error) {
          // With eager input streaming, unparseable tool JSON surfaces as a plain (non-API) error: re-issue a few times.
          if (error instanceof Anthropic.APIError || attempt >= MAX_JSON_RETRIES || signal?.aborted) throw error;
          if (text) onText("\n");
        }
      }
    },

    async listModels() {
      const models: string[] = [];
      for await (const m of getClient().models.list()) models.push(m.id);
      return models;
    },
  };
}
