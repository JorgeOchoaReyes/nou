// Starter plugin: finds TODO / FIXME / HACK comments, for you (/todos) and the model (find_todos).
import { execFileSync } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const MARKERS = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "__pycache__", "coverage"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_RESULTS = 200;

/** Files git knows about (so .gitignore is respected), or a plain walk outside a repo. */
function listFiles(cwd, under) {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", under || "."], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(path.join(cwd, dir))) {
        if (SKIP_DIRS.has(name) || files.length > 20_000) continue;
        const rel = path.join(dir, name);
        if (statSync(path.join(cwd, rel)).isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk(under || ".");
    return files;
  }
}

function findTodos(cwd, under) {
  const found = [];
  for (const file of listFiles(cwd, under)) {
    if (found.length >= MAX_RESULTS) break;
    try {
      const full = path.join(cwd, file);
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(full, "utf-8");
      if (text.includes("\0")) continue; // binary
      text.split("\n").forEach((line, i) => {
        const match = MARKERS.exec(line);
        if (match && found.length < MAX_RESULTS) found.push(`${file.replaceAll("\\", "/")}:${i + 1}  ${match[1]} ${match[2].trim()}`);
      });
    } catch {
      // unreadable or deleted: skip
    }
  }
  return found;
}

const report = (found) =>
  found.length ? `${found.length}${found.length === MAX_RESULTS ? "+" : ""} found:\n${found.join("\n")}` : "No TODO/FIXME/HACK comments found.";

export default {
  name: "TODOs",
  version: "0.1.0",
  description: "Lists TODO / FIXME / HACK comments. Adds a find_todos tool and /todos.",

  tools: [
    {
      readOnly: true,
      definition: {
        name: "find_todos",
        description: "List TODO, FIXME, HACK and XXX comments in the project (file:line and the note)",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Optional folder to search, relative to the project" } },
        },
      },
      run: (args, ctx) => report(findTodos(ctx.cwd, args.path)),
    },
  ],

  commands: [
    {
      name: "todos",
      description: "List TODO/FIXME comments: /todos [folder]",
      run: (args, ctx) => report(findTodos(ctx.cwd, args.trim())),
    },
  ],
};
