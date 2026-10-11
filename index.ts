import { existsSync } from "fs";
import { createElement } from "react";
import { render } from "ink";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { artWork } from "./src/util/index.js";
import { ensureProjectContext, loadPermanentContext } from "./src/context/index.js";
import { buildSystemPrompt } from "./src/agent/index.js";
import { describe, initialModel, resolveModel } from "./src/providers/index.js";
import { App } from "./src/ui/App.js";

async function main() {
  if (!process.stdin.isTTY) {
    console.error("Nou needs an interactive terminal (try Windows Terminal / PowerShell).");
    process.exit(1);
  }
  // API keys can live in a .env next to the project (it's gitignored).
  if (existsSync(".env")) process.loadEnvFile(".env");

  p.intro(chalk.cyan(`${artWork} \n Hello I am Nou! 🌞`));

  let choice = initialModel();
  const problem = choice.provider.unavailable();
  if (problem) {
    p.log.warn(`${choice.provider.label} isn't set up (${problem}), falling back to local Ollama.`);
    choice = resolveModel("ollama");
  }
  p.log.info(`Model: ${chalk.yellow(describe(choice))}  (change it any time with /model)`);

  await ensureProjectContext(choice);

  const permContext = await loadPermanentContext();

  const app = render(createElement(App, { initialModel: choice, systemPrompt: buildSystemPrompt(permContext) }), {
    alternateScreen: true,
  });
  await app.waitUntilExit();

  p.outro(chalk.cyan("Bye bye!"));
}

main().catch(console.error);
