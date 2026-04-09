import { highlight } from "cli-highlight";
import fs from "fs/promises";
import path from "path";
import { readFile, runCommand } from "../commands/index.js";
import ollama from "ollama";
import * as p from "@clack/prompts";

export const sugarfy = (str: string) => {
  return highlight(str, { language: "typescript", ignoreIllegals: true });
};

export async function generateContext(contextPath: string) {
  const s = p.spinner();
  s.start("Analyzing project structure to create NOU.md...");
  const dirStructure = await runCommand("dir /b");
  const packageJson = await readFile("package.json");
  const response = await ollama.chat({
    model: "llama3.1",
    messages: [{
      role: "user",
      content: `I am starting a new project. Based on these files: \n${dirStructure}\n\nAnd this package.json: \n${packageJson}\n\nPlease generate a NOU.md file that summarizes: 
      1. What this project is.
      2. Commands to build, test, and run it.
      3. Tech stack used.
      Output ONLY the markdown content.`
    }]
  });
  await fs.writeFile(contextPath, response.message.content);
  s.stop("NOU.md generated! Nou is now context-aware.");
}; 

export async function ensureProjectContext() {
  const contextPath = path.join(process.cwd(), "NOU.md");

  try {
    await fs.access(contextPath);
    const nonEmpty = (await fs.readFile(contextPath, "utf-8")).trim().length > 0;
    if (!nonEmpty) {
      await generateContext(contextPath);
    }
  } catch {
    await generateContext(contextPath);
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
