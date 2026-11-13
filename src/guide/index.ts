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
      const steps = tidySteps(args.steps);
      if (!steps.length) return "No usable steps: each needs a file, a line and the code to type. Call show_steps again.";
      onSteps(steps);
      return `Shown to the user as ${steps.length} step${steps.length > 1 ? "s" : ""} to type. Don't edit the files yourself; finish with a one-line summary.`;
    },
  };
}

/** Steps as the model gave them, kept when usable: a file, a line, code to type. */
function tidySteps(raw: unknown): GuideStep[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s: any) => typeof s?.file === "string" && typeof s?.code === "string" && s.code.trim())
    .map((s: any) => ({ file: path.relative(process.cwd(), path.resolve(s.file)).split(path.sep).join("/"), line: Math.max(1, Math.floor(Number(s.line) || 1)), code: s.code.replace(/\r\n/g, "\n").replace(/\n+$/, ""), why: String(s.why ?? "") }));
}

/** The fenced block other engines (which can't call Nou's tools) put their steps in. */
const BLOCK = /```nou-steps\s*\n([\s\S]*?)\n```/;

/**
 * The message that asks for steps. Nou's own engine hands them back with the show_steps tool; Claude
 * Code, Codex and pi can't call Nou's tools, so they end their reply with a ```nou-steps block instead.
 */
export function showMePrompt(task: string, withTool: boolean): string {
  const how = withTool
    ? `call ${SHOW_STEPS} once with the steps in order`
    : "end your reply with the steps in order as a JSON array in a fenced block marked nou-steps, like:\n```nou-steps\n[{\"file\": \"src/cli.ts\", \"line\": 12, \"code\": \"const verbose = args.includes(\\\"--verbose\\\");\", \"why\": \"Reads the new flag.\"}]\n```";
  return `[Show me how] ${task}\n\nDon't edit any files: I want to type it myself. Read what you need to find where it goes, then ${how} (each step: file, the line to add the code before, the exact lines of code to type, and why). Keep each step small, a few lines, so it's easy to follow.`;
}

/** Steps from a reply's ```nou-steps block, and the reply without it; null when there's none. */
export function stepsFromReply(text: string): { steps: GuideStep[]; rest: string } | null {
  const m = BLOCK.exec(text);
  if (!m) return null;
  try {
    const steps = tidySteps(JSON.parse(m[1]!));
    return steps.length ? { steps, rest: text.replace(m[0], "").trim() } : null;
  } catch {
    return null;
  }
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

/**
 * "Show me": the agent explains something and points at where it happens. Each stop is a range of a file
 * with what it shows; Nou opens them in the code view, highlighted, one after another.
 */
export type TourStop = {
  /** Project-relative path. */
  file: string;
  /** First and last line of the part to look at (1-based). */
  line: number;
  end: number;
  /** What this part does, for the explanation: a sentence or two. */
  note: string;
};

export const SHOW_PLACES = "show_places";

/** Stops as the model gave them, kept when usable: a file in the project and a line. */
export function tidyStops(raw: unknown): TourStop[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s: any) => typeof s?.file === "string" && s.file.trim() && Number(s.line) >= 1)
    .map((s: any) => {
      const line = Math.floor(Number(s.line));
      const end = Math.max(line, Math.floor(Number(s.end_line ?? s.end ?? line)) || line);
      return { file: path.relative(process.cwd(), path.resolve(s.file)).split(path.sep).join("/"), line, end, note: String(s.note ?? s.why ?? "").trim() };
    })
    .filter((s) => !s.file.startsWith(".."))
    .slice(0, 12);
}

/** The tool Nou's own engine points at places with. `onStops` gets them. */
export function showPlacesTool(onStops: (stops: TourStop[]) => void): ExtraTool {
  return {
    definition: {
      name: SHOW_PLACES,
      description: "When you explain how something works or where something happens in this project, point at the exact places so the user sees them: Nou opens each one in their code view, highlighted, in the order given. Call it once, after you've read the code, with the parts that matter (usually 1-6).",
      parameters: {
        type: "object",
        properties: {
          places: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Project-relative path." },
                line: { type: "number", description: "First line of the part (1-based)." },
                end_line: { type: "number", description: "Last line of the part." },
                note: { type: "string", description: "One or two plain sentences: what this part does, in terms of the explanation." },
              },
              required: ["file", "line", "end_line", "note"],
            },
          },
        },
        required: ["places"],
      },
    },
    readOnly: true,
    source: "nou",
    run: (args) => {
      const stops = tidyStops(args.places);
      if (!stops.length) return "No usable places: each needs a project file and a line. Call show_places again.";
      onStops(stops);
      return `Shown to the user: ${stops.length} place${stops.length > 1 ? "s" : ""}, opening the first. Now explain in the order of the places, naming each as path:line.`;
    },
  };
}

/**
 * The fenced block other engines (which can't call Nou's tools) list their places in. Models also write it
 * with ~~~, with CRLF, with the closing fence on the JSON's last line, or (unfenced) as a "nou-show" line
 * followed by the JSON array at the end of the reply.
 */
const SHOW_BLOCK = /(?:```|~~~)[ \t]*nou-show[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:```|~~~)|(?:^|\n)[ \t]*nou-show[ \t]*\r?\n[ \t]*(\[[\s\S]*\])\s*$/;

/**
 * A reply as the chat shows it: Nou's blocks (nou-show, nou-steps) are for Nou, not you, so they're never
 * drawn, including one still arriving mid-stream.
 */
export function hideNouBlocks(text: string): string {
  if (!text.includes("nou-") && !text.includes("mermaid")) return text;
  return text
    .replace(/(?:```|~~~)[ \t]*nou-(?:show|steps)[ \t]*\r?\n[\s\S]*?(?:```|~~~)/g, "")
    .replace(/(?:```|~~~)[ \t]*nou-(?:show|steps)[\s\S]*$/, "")
    // A diagram still arriving: it opens in the code view when the reply is done.
    .replace(/(?:```|~~~)[ \t]*(?:nou-diagram|mermaid)[ \t]*\r?\n(?![\s\S]*?(?:```|~~~))[\s\S]*$/, "")
    .replace(/(?:^|\n)[ \t]*nou-(?:show|steps)[ \t]*\r?\n[ \t]*\[[\s\S]*$/, "")
    .trimEnd();
}

/**
 * For Claude Code, Codex and pi, which can't call show_places: how to point at places, added to what they
 * know about the project, so explaining "where does X happen" opens the files on any engine.
 */
export const SHOW_PLACES_NOTE = "When you explain how something in this project works or where something happens, end your reply with the exact places, in the order to read them, as a JSON array in a fenced block marked nou-show. The user's editor opens each one highlighted:\n```nou-show\n[{\"file\": \"src/auth/session.ts\", \"line\": 40, \"end_line\": 58, \"note\": \"Checks the token and refuses expired ones.\"}]\n```\nOnly for places in this project you've actually read; leave it out when nothing needs showing.";

/** The message /showme sends: explain, and point at the places. */
export function explainPrompt(question: string, withTool: boolean): string {
  const how = withTool ? `call ${SHOW_PLACES} with them` : "list them in a nou-show block at the end, as described";
  return `[Show me] ${question}\n\nExplain this to me and show me where it happens in the code. Don't change any files. Read what you need, find the exact places (file and line range) that matter, ${how}, in the order to read them, and explain in that order, naming each as path:line.`;
}

/** Places from a reply's ```nou-show block, and the reply without it; null when there's none. */
export function stopsFromReply(text: string): { stops: TourStop[]; rest: string } | null {
  const m = SHOW_BLOCK.exec(text);
  if (!m) return null;
  try {
    const stops = tidyStops(JSON.parse((m[1] ?? m[2])!));
    return { stops, rest: text.replace(m[0], "").trim() };
  } catch {
    return null;
  }
}
