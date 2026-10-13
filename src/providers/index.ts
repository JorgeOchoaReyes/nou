import { loadSettings, saveSettings } from "../config/index.js";
import { originOf } from "../config/origins.js";
import { anthropicProvider } from "./anthropic.js";
import { ollamaProvider } from "./ollama.js";
import { OPENAI_COMPATIBLE, openAICompatibleProvider } from "./openai.js";
import type { Provider } from "./types.js";

export type * from "./types.js";

export const providers: Provider[] = [
  ollamaProvider(),
  ...OPENAI_COMPATIBLE.filter((p) => p.local).map(openAICompatibleProvider),
  anthropicProvider(),
  ...OPENAI_COMPATIBLE.filter((p) => !p.local).map(openAICompatibleProvider),
];

export type ModelChoice = { provider: Provider; model: string };

/**
 * Parses "provider:model" (e.g. "anthropic:claude-opus-5-5", "ollama:qwen3:8b").
 * A bare provider id picks its default model; anything else is treated as an Ollama model name.
 */
export function resolveModel(spec: string): ModelChoice {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  const head = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  const provider = providers.find((p) => p.id === head.toLowerCase());
  if (provider) {
    const model = colon >= 0 ? trimmed.slice(colon + 1) : "";
    return { provider, model: model || provider.defaultModel };
  }
  return { provider: providers[0]!, model: trimmed };
}

export const describe = (choice: ModelChoice) => `${choice.provider.id}:${choice.model}`;

/** Whether a provider error means the API key is wrong (rather than, say, the server being down). */
export const rejectedKey = (error: string) => /\b(401|403)\b|api key|unauthori[sz]ed|authentication/i.test(error);

/**
 * For an error that says the key was rejected: which key, where it was set, and how to fix it.
 * The usual cause is a project's .env holding a key for the app rather than for Nou.
 */
export function keyHint(provider: Provider, error: string): string | null {
  const key = provider.connect?.find((f) => f.secret)?.env;
  if (!key || !rejectedKey(error)) return null;
  const origin = originOf(key);
  const others = providers.filter((p) => p !== provider && !p.local && !p.unavailable()).map((p) => p.id);
  return `The ${key}${origin ? ` from ${origin}` : ""} was rejected. Enter another with /connect ${provider.id}`
    + (others.length ? `, or switch with /model ${others.join(" · /model ")}.` : ", or connect another provider (e.g. /connect litellm).");
}

/** NOU_MODEL wins, then the model saved in settings, then local Ollama. */
export function initialModel(): ModelChoice {
  if (process.env.NOU_MODEL) return resolveModel(process.env.NOU_MODEL);
  return resolveModel(loadSettings().model || "ollama");
}

export function saveModel(choice: ModelChoice) {
  saveSettings({ model: describe(choice) });
}

/** One-shot completion without tools, used for things like generating NOU.md. */
export async function complete(choice: ModelChoice, prompt: string): Promise<string> {
  const result = await choice.provider.chat({
    model: choice.model,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    onText: () => {},
  });
  return result.text;
}
