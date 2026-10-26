#!/usr/bin/env node
// Must stay the first import: loads .env before any provider reads its keys and URLs.
import "./src/env.js";
import { installFastWidth } from "./src/ui/fast-width.js";

// Ink's text measuring has to be swapped before Ink loads, so everything else is imported after it.
installFastWidth();
await import("./src/cli.js");
