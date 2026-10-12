import type { FileChange } from "../commands/index.js";
import { formatDiagnostic, type DiagnosticsManager } from "../diagnostics/index.js";
import { summary as gitSummary } from "../git/index.js";
import { gitTools } from "../git/tools.js";
import type { NouPlugin } from "../plugins/index.js";
import type { ExtraTool } from "./index.js";

/**
 * Everything the agent gets on top of the built-in tools: git context and tools, plugin prompts and tools,
 * and the problems checker. Shared by the app and the evals, so evals measure exactly what users get.
 */
export function harness(options: { diagnostics: DiagnosticsManager; plugins: NouPlugin[]; git: boolean }): { extras: string[]; extraTools: ExtraTool[] } {
  const { diagnostics, plugins, git } = options;
  const extras: string[] = [];
  const extraTools: ExtraTool[] = [];
  if (git) {
    const summary = gitSummary();
    if (summary) extras.push(summary);
    extraTools.push(...gitTools());
  }
  for (const plugin of plugins) {
    if (plugin.systemPrompt) extras.push(`Plugin ${plugin.name}: ${plugin.systemPrompt}`);
    for (const tool of plugin.tools ?? []) {
      extraTools.push({
        definition: tool.definition,
        readOnly: !!tool.readOnly,
        source: plugin.name,
        run: (args) => tool.run(args, { cwd: process.cwd() }),
      });
    }
  }
  extraTools.push({
    source: "problems",
    readOnly: true,
    definition: {
      name: "get_diagnostics",
      description: "Get errors and warnings from the project's linters, type checker and language servers, for one file or the whole project.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Optional file. Omit for the whole project." } }, required: [] },
    },
    run: async (args) => {
      const file = typeof args.path === "string" ? args.path : null;
      if (file) await diagnostics.checkFile(file);
      else await diagnostics.checkProject();
      const list = file ? diagnostics.get(file) : diagnostics.all();
      return list.length ? list.slice(0, 100).map((d) => formatDiagnostic(d, true)).join("\n") : "No problems found.";
    },
  });
  return { extras, extraTools };
}

/** Problems an applied edit introduced, to feed back to the model (the agent's checkChange hook). */
export async function problemsIntroduced(diagnostics: DiagnosticsManager, change: FileChange): Promise<string | null> {
  const introduced = await diagnostics.introducedBy(change.path, change.before, change.after);
  return introduced.length ? introduced.slice(0, 15).map((d) => formatDiagnostic(d)).join("\n") : null;
}
