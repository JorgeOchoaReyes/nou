/** Provider-neutral conversation format. Each provider converts to and from its own API shape. */

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, any>;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      /** The provider's own copy of this turn (e.g. Claude thinking blocks), replayed unchanged to the same provider. */
      raw?: { provider: string; data: unknown };
    }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };

export type ToolDef = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, any>; required: string[] };
};

export type ChatRequest = {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  onText(delta: string): void;
  signal?: AbortSignal;
  /** Reasoning effort, for models that support it. */
  effort?: string;
};

export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
  raw?: { provider: string; data: unknown };
  /** Set when the turn ended abnormally and its tool calls must not run. */
  stop?: "max_tokens" | "refusal";
};

/** Something to ask for when connecting a provider from inside Nou: the env var it's saved as. */
export type ConnectField = { env: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string };

export interface Provider {
  id: string;
  label: string;
  local: boolean;
  defaultModel: string;
  /** What to ask for to set it up from inside Nou (settings → Model, or /connect). Omitted when there's nothing to enter. */
  connect?: ConnectField[];
  /** Why this provider can't be used right now (e.g. missing API key), or null if it's ready. */
  unavailable(): string | null;
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<string[]>;
  /** Its OpenAI-compatible endpoint, for engines that bring their own client (pi). */
  endpoint?(): { baseURL: string; apiKey: string; api: "openai-completions" | "anthropic-messages" };
  /** Downloads a model (local providers that can, i.e. Ollama). `percent` is null while there's no size yet. */
  pull?(model: string, onProgress: (status: string, percent: number | null) => void, signal?: AbortSignal): Promise<void>;
}
