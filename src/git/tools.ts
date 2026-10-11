import type { ExtraTool } from "../agent/index.js";
import { branch, diffText, isRepo, log, status } from "./index.js";

/** Read-only git tools for the model. */
export function gitTools(): ExtraTool[] {
  if (!isRepo()) return [];
  return [
    {
      source: "git",
      readOnly: true,
      definition: {
        name: "git_status",
        description: "Show the current git branch and uncommitted changes (M modified, A added, D deleted, ? untracked).",
        parameters: { type: "object", properties: {}, required: [] },
      },
      run: () => {
        const changes = [...status()].map(([file, code]) => `${code} ${file}`);
        return `Branch: ${branch()}\n${changes.join("\n") || "Working tree clean."}`;
      },
    },
    {
      source: "git",
      readOnly: true,
      definition: {
        name: "git_diff",
        description: "Show uncommitted changes as a unified diff against HEAD, for one file or the whole repo.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional file to diff. Omit for all changes." },
            staged: { type: "boolean", description: "Only show staged changes." },
          },
          required: [],
        },
      },
      run: (args) => diffText(typeof args.path === "string" ? args.path : undefined, args.staged === true),
    },
    {
      source: "git",
      readOnly: true,
      definition: {
        name: "git_log",
        description: "Show recent commits (hash, date, author, message).",
        parameters: {
          type: "object",
          properties: { count: { type: "number", description: "How many commits, default 10, max 50." } },
          required: [],
        },
      },
      run: (args) => log(typeof args.count === "number" ? args.count : 10),
    },
  ];
}
