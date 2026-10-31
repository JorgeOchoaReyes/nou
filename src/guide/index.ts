import path from "path";
import type { ExtraTool } from "../agent/index.js";

/**
 * "Show me how": instead of making a change, Nou's engine finds where it goes and hands back steps; Nou
 * walks you through them in the editor, one at a time, with the code to type shown ahead of your cursor.
 */
export type GuideStep = {
  /** Project-relative path. */
  file: string;
  /** The code goes in before this line (1-based; one past the end adds it at the end). */
  line: number;
  /** What to type, whole lines. */
  code: string;
  /** Why it's needed, in a sentence or two. */
  why: string;
};

export const SHOW_STEPS = "show_steps";

/** The tool the engine hands its steps back with. `onSteps` gets them; the engine is told they're shown. */
export function showStepsTool(onSteps: (steps: GuideStep[]) => void): ExtraTool {
  return {
    definition: {
      name: SHOW_STEPS,
      description: "Only when the user asked you to show them how ([Show me how] in their message): hand back the change as steps for them to type themselves, instead of editing. Each step adds whole lines of code before a line of a file, with why it's needed. Call it once, with every step in order.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Project-relative path of the file to add to." },
                line: { type: "number", description: "1-based line the code goes in before (the line after the last one appends)." },
                code: { type: "string", description: "The lines to type, indented as they'll be in the file." },
                why: { type: "string", description: "One or two plain sentences: what this does and why it's needed." },
              },
              required: ["file", "line", "code", "why"],
            },
          },
        },
        required: ["steps"],
      },
    },
    readOnly: true,
    source: "nou",
    run: (args) => {
      const steps = (Array.isArray(args.steps) ? args.steps : [])
        .filter((s: any) => typeof s?.file === "string" && typeof s?.code === "string" && s.code.trim())
        .map((s: any) => ({ file: path.relative(process.cwd(), path.resolve(s.file)).split(path.sep).join("/"), line: Math.max(1, Math.floor(Number(s.line) || 1)), code: s.code.replace(/\r\n/g, "\n").replace(/\n+$/, ""), why: String(s.why ?? "") }));
      if (!steps.length) return "No usable steps: each needs a file, a line and the code to type. Call show_steps again.";
      onSteps(steps);
      return `Shown to the user as ${steps.length} step${steps.length > 1 ? "s" : ""} to type. Don't edit the files yourself; finish with a one-line summary.`;
    },
  };
}

/** The message that asks for steps. */
export function showMePrompt(task: string): string {
  return `[Show me how] ${task}\n\nDon't edit any files: I want to type it myself. Read what you need to find where it goes, then call ${SHOW_STEPS} once with the steps in order (each: file, the line to add before, the exact lines of code to type, and why). Keep each step small, a few lines, so it's easy to follow.`;
}

/**
 * How far the text typed so far (`typed`, from where the step starts to the cursor) gets through
 * `expected`: the index reached in `expected`, or -1 when it doesn't match. Leading indentation on each
 * line is ignored either way, since the editor indents new lines itself.
 */
export function guideProgress(typed: string, expected: string): number {
  let i = 0;
  let j = 0;
  const skipIndent = (s: string, k: number) => {
    while (k < s.length && (s[k] === " " || s[k] === "\t")) k++;
    return k;
  };
  i = skipIndent(typed, i);
  j = skipIndent(expected, j);
  while (i < typed.length) {
    if (j >= expected.length || typed[i] !== expected[j]) return -1;
    const newline = typed[i] === "\n";
    i++;
    j++;
    if (newline) {
      i = skipIndent(typed, i);
      // The rest of the expected indentation counts as typed only once something follows it.
      if (i < typed.length) j = skipIndent(expected, j);
    }
  }
  return j;
}
