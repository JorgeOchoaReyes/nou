// Starter plugin: gives the model the instructions you already wrote for other coding agents
// (AGENTS.md, CLAUDE.md, Cursor and Copilot rules), so you don't have to repeat them in NOU.md.
import { existsSync, readFileSync } from "fs";
import path from "path";
import process from "process";

const FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"];
const MAX_CHARS = 8_000;

function readRules(cwd) {
  return FILES.filter((file) => existsSync(path.join(cwd, file)))
    .map((file) => {
      const text = readFileSync(path.join(cwd, file), "utf-8").trim();
      return { file, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[... cut]` : text };
    })
    .filter((rule) => rule.text);
}

export default {
  name: "Project rules",
  version: "0.1.0",
  description: "Reads AGENTS.md, CLAUDE.md, .cursorrules and Copilot instructions into the system prompt. /rules lists them.",

  // A getter, so edits to those files are picked up whenever the prompt is rebuilt.
  get systemPrompt() {
    const rules = readRules(process.cwd());
    if (!rules.length) return undefined;
    return `Follow the project's own instructions:\n${rules.map((r) => `--- ${r.file} ---\n${r.text}`).join("\n\n")}`;
  },

  commands: [
    {
      name: "rules",
      description: "Show which instruction files are in use",
      run(args, ctx) {
        const rules = readRules(ctx.cwd);
        return rules.length
          ? `Using: ${rules.map((r) => `${r.file} (${r.text.length} chars)`).join(", ")}`
          : `None found. Looked for ${FILES.join(", ")}.`;
      },
    },
  ],
};
