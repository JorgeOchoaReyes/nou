import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
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

const CONFIG_PATH = path.join(os.homedir(), ".nou", "config.json");

/** NOU_MODEL wins, then the last model picked with /model, then local Ollama. */
export function initialModel(): ModelChoice {
  if (process.env.NOU_MODEL) return resolveModel(process.env.NOU_MODEL);
  try {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof saved.model === "string") return resolveModel(saved.model);
  } catch {
    // no saved choice yet
  }
  return resolveModel("ollama");
}

export function saveModel(choice: ModelChoice) {
  try {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, model: describe(choice) }, null, 2));
  } catch {
    // remembering the model is best effort
  }
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
