import { Ollama, type Message } from "ollama";
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall } from "./types.js";
import { newCallId } from "./ids.js";

/** Context window to ask for when a model doesn't set its own: enough for the system prompt, files and history. */
const DEFAULT_NUM_CTX = 32_768;

/**
 * Ollama's default context window is small, and it silently drops whatever doesn't fit (often the system
 * prompt). Ask for a bigger one, capped at what the model supports, unless its Modelfile sets num_ctx.
 * Returns null to leave Ollama's setting alone.
 */
export function pickNumCtx(parameters: string | undefined, modelInfo: Record<string, unknown> | undefined): number | null {
  if (/^num_ctx\s/m.test(parameters ?? "")) return null;
  const max = Object.entries(modelInfo ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
  return typeof max === "number" && max > 0 ? Math.min(DEFAULT_NUM_CTX, max) : DEFAULT_NUM_CTX;
}

export function ollamaProvider(): Provider {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const client = new Ollama({ host });
  const contextSizes = new Map<string, Promise<number | null>>();

  /** NOU_NUM_CTX wins; otherwise worked out once per model from what Ollama reports about it. */
  const numCtx = (model: string): Promise<number | null> => {
    if (process.env.NOU_NUM_CTX) return Promise.resolve(Number(process.env.NOU_NUM_CTX) || null);
    let size = contextSizes.get(model);
    if (!size) {
      // model_info is typed as a Map but arrives as a plain object.
      size = client.show({ model })
        .then((info) => pickNumCtx(info.parameters, info.model_info as unknown as Record<string, unknown>))
        .catch(() => null);
      contextSizes.set(model, size);
    }
    return size;
  };

  const toOllama = (system: string, messages: ChatMessage[]): Message[] => [
    { role: "system", content: system },
    ...messages.map((m): Message => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "tool") return { role: "tool", content: m.content, tool_name: m.name };
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
      };
    }),
  ];

  return {
    id: "ollama",
    label: `Ollama (${host})`,
    local: true,
    defaultModel: "qwen3:8b",
    unavailable: () => null,

    async chat({ model, system, messages, tools, onText, signal }: ChatRequest): Promise<ChatResult> {
      const num_ctx = await numCtx(model);
      const stream = await client.chat({
        model,
        messages: toOllama(system, messages),
        ...(num_ctx ? { options: { num_ctx } } : {}),
        tools: tools.map((t) => ({ type: "function", function: t })),
        stream: true,
      });
      const onAbort = () => stream.abort();
      signal?.addEventListener("abort", onAbort);

      let text = "";
      const toolCalls: ToolCall[] = [];
      try {
        for await (const part of stream) {
          if (part.message.content) {
            text += part.message.content;
            onText(part.message.content);
          }
          for (const call of part.message.tool_calls ?? []) {
            toolCalls.push({ id: newCallId(), name: call.function.name, args: call.function.arguments ?? {} });
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      return { text, toolCalls };
    },

    async listModels() {
      const { models } = await client.list();
      return models.map((m) => m.name);
    },
  };
}
