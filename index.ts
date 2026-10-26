#!/usr/bin/env node
// Must stay the first import: loads .env before any provider reads its keys and URLs.
import "./src/env.js";
import { installFastWidth } from "./src/ui/fast-width.js";

// Answered before loading the rest, which takes most of a second.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  const { currentVersion } = await import("./src/update/index.js");
  console.log(currentVersion());
  process.exit(0);
}

// Ink's text measuring has to be swapped before Ink loads, so everything else is imported after it.
installFastWidth();
await import("./src/cli.js");
