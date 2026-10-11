import { Ollama, type Message } from "ollama";
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall } from "./types.js";
import { newCallId } from "./ids.js";

export function ollamaProvider(): Provider {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const client = new Ollama({ host });

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
      const stream = await client.chat({
        model,
        messages: toOllama(system, messages),
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
