// Copies the tree-sitter grammars Nou supports into dist/grammars (the full set is 50 MB; we ship ~12).
import { copyFileSync, mkdirSync, statSync } from "fs";
import { createRequire } from "module";
import path from "path";

const { SHIPPED_GRAMMARS } = await import("../dist/src/syntax/index.js");
const require = createRequire(import.meta.url);
const source = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const target = path.join("dist", "grammars");
mkdirSync(target, { recursive: true });
let total = 0;
for (const name of SHIPPED_GRAMMARS) {
  const file = `tree-sitter-${name}.wasm`;
  copyFileSync(path.join(source, file), path.join(target, file));
  total += statSync(path.join(target, file)).size;
}
console.log(`Copied ${SHIPPED_GRAMMARS.length} grammars (${(total / 1024 / 1024).toFixed(1)} MB) to ${target}`);
