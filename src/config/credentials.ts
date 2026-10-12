import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { NOU_HOME } from "./index.js";

/**
 * API keys and base URLs you enter inside Nou (settings → Model, or /connect), saved as env var name -> value.
 * They fill in only what your environment and .env leave unset, so those always win.
 */
const CREDENTIALS_PATH = path.join(NOU_HOME, "credentials.json");

function readSaved(): Record<string, string> {
  try {
    const saved = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    return Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
  } catch {
    return {};
  }
}

/** Fills in saved keys and URLs for anything not already set. Call before choosing a model. */
export function loadCredentials() {
  for (const [name, value] of Object.entries(readSaved())) process.env[name] ??= value;
}

/** Saves keys and URLs (readable only by you) and applies them to this session. Empty values are skipped. */
export function saveCredentials(values: Record<string, string>) {
  const next = readSaved();
  for (const [name, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    next[name] = trimmed;
    process.env[name] = trimmed;
  }
  if (!existsSync(NOU_HOME)) mkdirSync(NOU_HOME, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600); // the mode above only applies when the file is created
  } catch {
    // Windows ignores it
  }
}
