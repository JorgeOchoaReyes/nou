#!/usr/bin/env node
import { existsSync } from "fs";
import { createElement } from "react";
import { render } from "ink";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { artWork } from "./src/util/index.js";
import { ensureProjectContext, loadPermanentContext } from "./src/context/index.js";
import { describe, initialModel, resolveModel } from "./src/providers/index.js";
import { checkForUpdate, currentVersion, installUpdate, relaunch } from "./src/update/index.js";
import { lsp } from "./src/lsp/index.js";
import { App } from "./src/ui/App.js";

const HELP = `nou ${currentVersion()}: an AI coding assistant for your terminal

Usage:
  nou              open Nou in the current folder
  nou update       update to the latest version
  nou --version    print the version
  nou --help       show this help

Settings live in ~/.nou/config.json (or press s inside Nou). Set NOU_NO_UPDATE_CHECK=1 to skip update checks.`;

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
  // API keys can live in a .env next to the project (it's gitignored).
  if (existsSync(".env")) process.loadEnvFile(".env");

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

  let choice = initialModel();
  const problem = choice.provider.unavailable();
  if (problem) {
    p.log.warn(`${choice.provider.label} isn't set up (${problem}), falling back to local Ollama.`);
    choice = resolveModel("ollama");
  }
  p.log.info(`Model: ${chalk.yellow(describe(choice))}  (change it any time with /model)`);

  await ensureProjectContext(choice);

  const permContext = await loadPermanentContext();

  // Ctrl+C is handled inside the app: press it twice to quit, so a stray press doesn't lose work.
  const app = render(createElement(App, { initialModel: choice, permContext }), {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  lsp.stopAll();

  p.outro(chalk.cyan("Bye bye!"));
}

main().catch(console.error);
