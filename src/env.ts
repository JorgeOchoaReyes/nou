import { existsSync } from "fs";

// This module must be imported before anything else (index.ts imports it first).

// npm only warns about an unsupported Node version, so check here, before Ink loads and fails confusingly.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major! < 22 || (major === 22 && minor! < 12)) {
  console.error(`Nou needs Node.js 22.12 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

// Load the project's .env (API keys, base URLs). Providers read their settings when they load,
// so loading .env later would be too late for them.
if (existsSync(".env")) process.loadEnvFile(".env");
