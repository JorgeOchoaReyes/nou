import { highlight } from "cli-highlight";
import fs from "fs/promises";
import path from "path";
import { fileTree, readFile } from "../commands/index.js";
import { complete, type ModelChoice } from "../providers/index.js";
import * as p from "@clack/prompts";

export const sugarfy = (str: string) => {
  return highlight(str, { language: "typescript", ignoreIllegals: true });
};

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

export async function loadPermanentContext(): Promise<string> {
  const contextPath = path.join(process.cwd(), "NOU.md");
  try {
    const content = await fs.readFile(contextPath, "utf-8");
    return `\n\nPROJECT SPECIFIC RULES (from NOU.md):\n${content}`;
  } catch (err: unknown) { 
    return "";
  }
}
