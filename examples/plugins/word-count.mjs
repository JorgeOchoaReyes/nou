// Example Nou plugin. Copy it to `.nou/plugins/` in a project (or `~/.nou/plugins/`),
// then enable it in /settings → Plugins.
import { readFile } from "fs/promises";
import path from "path";

export default {
  name: "word-count",
  version: "0.1.0",
  description: "Counts lines and words in a file. Adds a word_count tool and a /wc command.",

  // Extra instructions for the model while the plugin is enabled.
  systemPrompt: "Use word_count when the user asks how long a file is.",

  tools: [
    {
      readOnly: true, // read-only tools run without asking
      definition: {
        name: "word_count",
        description: "Count the lines and words in a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File to count" } },
          required: ["path"],
        },
      },
      async run(args, ctx) {
        const text = await readFile(path.resolve(ctx.cwd, args.path), "utf-8");
        return `${args.path}: ${text.split("\n").length} lines, ${text.split(/\s+/).filter(Boolean).length} words`;
      },
    },
  ],

  commands: [
    {
      name: "wc",
      description: "Count lines and words: /wc <file>",
      async run(args, ctx) {
        if (!args) return "Usage: /wc <file>";
        const text = await readFile(path.resolve(ctx.cwd, args), "utf-8");
        return `${args}: ${text.split("\n").length} lines, ${text.split(/\s+/).filter(Boolean).length} words`;
      },
    },
  ],
};
