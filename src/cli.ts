// The whole command line program; index.ts loads it once the environment is ready.
import { createElement } from "react";
import { render } from "ink";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { artWork } from "./util/index.js";
import { ensureProjectContext, loadPermanentContext } from "./context/index.js";
import { describe, initialModel, resolveModel, saveModel } from "./providers/index.js";
import { loadSettings } from "./config/index.js";
import { loadCredentials } from "./config/credentials.js";
import { borrowToolConfig, ensureLocalModel, pickStartingModel } from "./setup/index.js";
import { checkForUpdate, currentVersion, installUpdate, relaunch } from "./update/index.js";
import { lsp } from "./lsp/index.js";
import { App } from "./ui/App.js";
import { installFastOutput } from "./ui/fast-output.js";
import { RENDER_OPTIONS } from "./ui/render-options.js";

const HELP = `nou ${currentVersion()}: an AI coding assistant for your terminal

Usage:
  nou              open Nou in the current folder
  nou update       update to the latest version
  nou --version    print the version
  nou --help       show this help

Settings live in ~/.nou/config.json (or press s inside Nou); keys you enter there, or with /connect, in ~/.nou/credentials.json. Set NOU_NO_UPDATE_CHECK=1 to skip update checks.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(currentVersion());
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args[0] === "update") {
    const latest = await checkForUpdate({ force: true, timeout: 10_000 });
    if (!latest) {
      console.log(`nou ${currentVersion()} is up to date.`);
      return;
    }
    console.log(`Updating nou ${currentVersion()} → ${latest}...`);
    if (await installUpdate(latest)) process.exit(0);
    if (process.platform !== "win32") console.log("If that was a permissions error, run: sudo npm install -g nou-cli@latest");
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error("Nou needs an interactive terminal (try Windows Terminal, PowerShell, or Terminal/iTerm on macOS).");
    process.exit(1);
  }
  p.intro(chalk.cyan(`${artWork} \n Hello I am Nou! 🌞  ${chalk.dim(`v${currentVersion()}`)}`));

  const latest = await checkForUpdate();
  if (latest) {
    const update = await p.confirm({ message: `Nou ${chalk.green(latest)} is available (you have ${currentVersion()}). Update now?` });
    if (update === true) {
      const ok = await installUpdate(latest);
      if (ok) {
        p.log.success(`Updated to ${latest}. Restarting...`);
        relaunch();
        return;
      }
      p.log.warn(process.platform === "win32"
        ? "The update failed. You can retry later with: npm install -g nou-cli@latest"
        : "The update failed. If it was a permissions error, run: sudo npm install -g nou-cli@latest");
    }
  }

  const settings = loadSettings();
  loadCredentials(); // keys entered inside Nou, for whatever the environment and .env leave unset
  const borrowed = settings.reuseToolConfig ? borrowToolConfig() : [];
  for (const b of borrowed) p.log.info(`Using the ${b.provider === "anthropic" ? "Anthropic" : "OpenAI"} API key from your ${b.tool} settings.`);

  let choice = initialModel();
  // First run: start with a model that's already here, if there is one.
  if (!process.env.NOU_MODEL && !settings.model) {
    const picked = await pickStartingModel(borrowed);
    if (picked) {
      choice = picked;
      saveModel(picked);
    }
  }
  const problem = choice.provider.unavailable();
  if (problem) {
    p.log.warn(`${choice.provider.label} isn't set up (${problem}), falling back to local Ollama.`);
    choice = resolveModel("ollama");
  }
  const ready = await ensureLocalModel(choice);
  if (ready !== choice) saveModel(ready); // picked a model that's already installed instead
  choice = ready;
  p.log.info(`Model: ${chalk.yellow(describe(choice))}  (change it any time with /model)`);

  // NOU.md is for Nou's own engine; the others read their own files (CLAUDE.md, AGENTS.md).
  if ((settings.engine ?? "nou") === "nou") await ensureProjectContext(choice);

  const permContext = await loadPermanentContext();

  await installFastOutput();
  const app = render(createElement(App, { initialModel: choice, permContext }), RENDER_OPTIONS);
  await app.waitUntilExit();
  lsp.stopAll();

  p.outro(chalk.cyan("Bye bye!"));
}

main().catch(console.error);
