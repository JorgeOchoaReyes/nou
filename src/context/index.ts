import fs from "fs/promises";
import path from "path";
import { fileTree, readFile } from "../commands/index.js";
import { complete, type ModelChoice } from "../providers/index.js";
import * as p from "@clack/prompts";
import { NOU_HOME } from "../config/index.js";

export async function generateContext(contextPath: string, choice: ModelChoice) {
  const s = p.spinner();
  s.start("Analyzing project structure to create NOU.md...");
  const dirStructure = fileTree(".", 2);
  const packageJson = await readFile("package.json");
  let content: string;
  try {
    content = await complete(choice, `I am starting a new project. Based on these files: \n${dirStructure}\n\nAnd this package.json: \n${packageJson}\n\nPlease generate a NOU.md file that summarizes: 
      1. What this project is.
      2. Commands to build, test, and run it.
      3. Tech stack used.
      Output ONLY the markdown content.`);
  } catch (error: any) {
    s.stop(`Skipped NOU.md: ${error.message}`);
    return;
  }
  await fs.writeFile(contextPath, content);
  s.stop("NOU.md generated! Nou is now context-aware.");
}; 

export async function ensureProjectContext(choice: ModelChoice) {
  const contextPath = path.join(process.cwd(), "NOU.md");

  try {
    await fs.access(contextPath);
    const nonEmpty = (await fs.readFile(contextPath, "utf-8")).trim().length > 0;
    if (!nonEmpty) {
      await generateContext(contextPath, choice);
    }
  } catch {
    await generateContext(contextPath, choice);
  }
}

/** Instruction files other coding agents use too, so a repo's existing rules apply to Nou as well. */
const INSTRUCTION_FILES = ["NOU.md", "AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTIONS = 20_000;

/**
 * The project's standing instructions: NOU.md, AGENTS.md and CLAUDE.md here and in the folders above it
 * up to the repository root (outermost first, so nearer files have the last word), plus ~/.nou/NOU.md.
 */
export async function loadPermanentContext(): Promise<string> {
  const dirs: string[] = [];
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    const atRoot = await fs.access(path.join(dir, ".git")).then(() => true, () => false);
    if (atRoot || path.dirname(dir) === dir) break;
  }
  const files = [path.join(NOU_HOME, "NOU.md"), ...dirs.flatMap((dir) => INSTRUCTION_FILES.map((name) => path.join(dir, name)))];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const file of files) {
    const content = (await fs.readFile(file, "utf-8").catch(() => "")).trim();
    if (!content || seen.has(content)) continue;
    seen.add(content);
    const where = file.startsWith(NOU_HOME) ? "~/.nou/NOU.md" : path.relative(process.cwd(), file) || path.basename(file);
    parts.push(`From ${where}:\n${content.length > MAX_INSTRUCTIONS ? `${content.slice(0, MAX_INSTRUCTIONS)}\n[... cut]` : content}`);
  }
  return parts.length ? `\n\nPROJECT SPECIFIC RULES:\n${parts.join("\n\n")}` : "";
}

/**
 * Just the NOU.md parts of the project rules, for engines that read AGENTS.md / CLAUDE.md themselves
 * (Claude Code, Codex): giving them those again would only repeat them.
 */
export function nouRulesOnly(rules: string): string {
  const parts = rules.replace(/^\s*PROJECT SPECIFIC RULES:\n/, "").split(/\n\n(?=From )/).filter((p) => /^From (\S*[\\/])?NOU\.md:|^From ~\/\.nou\/NOU\.md:/.test(p.trim()));
  return parts.length ? `\n\nPROJECT SPECIFIC RULES:\n${parts.join("\n\n")}` : "";
}
