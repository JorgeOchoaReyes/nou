import OpenAI from "openai";
import type { ChatMessage, ChatRequest, ChatResult, ConnectField, Provider, ToolCall } from "./types.js";
import { newCallId } from "./ids.js";

type Preset = {
  id: string;
  label: string;
  baseURL: string;
  /** Env var holding the API key; omitted for local servers. */
  keyEnv?: string;
  /** Env var that overrides the base URL. */
  urlEnv?: string;
  /** Other names the same URL and key often go by, read when the main ones aren't set. */
  aliases?: { url?: string[]; key?: string[] };
  defaultModel: string;
  local: boolean;
  /** Where to get a key, shown when connecting. */
  keyHint?: string;
};

/** Everything that speaks the OpenAI chat completions API. */
export const OPENAI_COMPATIBLE: Preset[] = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", urlEnv: "OPENAI_BASE_URL", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5", local: false },
  { id: "gemini", label: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-pro", local: false },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-opus-5-5", local: false },
  { id: "groq", label: "Groq", baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", local: false },
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", local: false },
  { id: "fireworks", label: "Fireworks AI", baseURL: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/kimi-k2-instruct", local: false, keyHint: "fireworks.ai/account/api-keys" },
  // A LiteLLM proxy, or any hosted OpenAI-compatible gateway: cloud-sized context, unlike "custom".
  { id: "litellm", label: "LiteLLM / gateway", baseURL: "", urlEnv: "LITELLM_BASE_URL", keyEnv: "LITELLM_API_KEY", defaultModel: "gpt-5", local: false, keyHint: "your proxy's virtual key or master key",
    // The names LiteLLM's own SDK uses for a proxy (its litellm_proxy provider).
    aliases: { url: ["LITELLM_PROXY_API_BASE"], key: ["LITELLM_PROXY_API_KEY"] } },
  { id: "lmstudio", label: "LM Studio", baseURL: "http://localhost:1234/v1", urlEnv: "LMSTUDIO_BASE_URL", defaultModel: "local-model", local: true },
  { id: "llamacpp", label: "llama.cpp server", baseURL: "http://localhost:8080/v1", urlEnv: "LLAMACPP_BASE_URL", defaultModel: "local-model", local: true },
  { id: "custom", label: "Custom OpenAI-compatible", baseURL: "", urlEnv: "NOU_BASE_URL", keyEnv: "NOU_API_KEY", defaultModel: "default", local: true },
];

function toOpenAI(system: string, messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
    else {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
          : {}),
      });
    }
  }
  return out;
}

export function openAICompatibleProvider(preset: Preset): Provider {
  // Read when used, not when loaded: keys found in other tools' config (see setup/) are added at startup.
  const first = (names: (string | undefined)[]) => names.map((n) => n && process.env[n]).find(Boolean);
  const baseURL = () => first([preset.urlEnv, ...(preset.aliases?.url ?? [])]) || preset.baseURL;
  const apiKey = () => first([preset.keyEnv, ...(preset.aliases?.key ?? [])]) || (preset.local ? "not-needed" : "");
  // Rebuilt when the URL or key changes (they can be entered while Nou runs).
  let client: { url: string; key: string; api: OpenAI } | null = null;
  const getClient = () => {
    const url = baseURL();
    const key = apiKey();
    if (client?.url !== url || client.key !== key) client = { url, key, api: new OpenAI({ baseURL: url, apiKey: key }) };
    return client.api;
  };
  const connect: ConnectField[] = [
    ...(preset.urlEnv ? [{ env: preset.urlEnv, label: "Base URL", optional: !!preset.baseURL, placeholder: preset.baseURL || "https://your-proxy.example.com/v1" }] : []),
    ...(preset.keyEnv ? [{ env: preset.keyEnv, label: "API key", secret: true, optional: preset.local, ...(preset.keyHint ? { placeholder: preset.keyHint } : {}) }] : []),
  ];

  return {
    id: preset.id,
    label: preset.label,
    local: preset.local,
    defaultModel: preset.defaultModel,
    ...(connect.length ? { connect } : {}),
    endpoint: () => ({ baseURL: baseURL(), apiKey: apiKey() || "not-needed", api: "openai-completions" as const }),

    unavailable() {
      if (!baseURL()) return `set ${preset.urlEnv}`;
      if (!apiKey()) return `set ${preset.keyEnv}`;
      return null;
    },

    async chat({ model, system, messages, tools, onText, signal, effort }: ChatRequest): Promise<ChatResult> {
      // OpenAI's reasoning models take an effort too (named in the model id, through a gateway too). Nou's
      // default, high, is their default, medium; xhigh and max are their high.
      const reasoning = effort && /(^|\/)(gpt-5|o\d)/.test(model) ? ({ low: "low", medium: "low", high: "medium" } as Record<string, "low" | "medium" | "high">)[effort] ?? "high" : null;
      const stream = await getClient().chat.completions.create(
        {
          model,
          ...(reasoning ? { reasoning_effort: reasoning } : {}),
          messages: toOpenAI(system, messages),
          ...(tools.length ? { tools: tools.map((t) => ({ type: "function" as const, function: t })) } : {}),
          stream: true,
        },
        signal ? { signal } : {},
      );

      let text = "";
      let finish: string | null = null;
      // Tool calls stream in fragments keyed by index.
      const partial = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          text += choice.delta.content;
          onText(choice.delta.content);
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = partial.get(delta.index) ?? { id: "", name: "", args: "" };
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.name += delta.function.name;
          if (delta.function?.arguments) call.args += delta.function.arguments;
          partial.set(delta.index, call);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const toolCalls: ToolCall[] = [...partial.values()].map((c) => {
        let args: Record<string, any>;
        try {
          args = c.args ? JSON.parse(c.args) : {};
        } catch {
          args = { __invalid_json: c.args };
        }
        return { id: c.id || newCallId(), name: c.name, args };
      });
      return { text, toolCalls, ...(finish === "length" && toolCalls.length ? { stop: "max_tokens" as const } : {}) };
    },

    async listModels() {
      const models: string[] = [];
      for await (const m of getClient().models.list()) models.push(m.id);
      return models.sort();
    },
  };
}
