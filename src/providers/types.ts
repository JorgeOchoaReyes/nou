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

export interface Provider {
  id: string;
  label: string;
  local: boolean;
  defaultModel: string;
  /** Why this provider can't be used right now (e.g. missing API key), or null if it's ready. */
  unavailable(): string | null;
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<string[]>;
  /** Downloads a model (local providers that can, i.e. Ollama). `percent` is null while there's no size yet. */
  pull?(model: string, onProgress: (status: string, percent: number | null) => void, signal?: AbortSignal): Promise<void>;
}
