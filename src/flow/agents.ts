/**
 * Built-in agents for flows: a name and standing instructions that say what to produce and how to check it, so
 * each one hands on something the next can use. Every chat in a flow ends its reply with a short report in the
 * same shape (REPORT_NOTE), and that report is what's handed on (reportFromReply).
 */
export type AgentPreset = { name: string; summary: string; role: string };

export const AGENT_PRESETS: AgentPreset[] = [
  {
    name: "Planner",
    summary: "breaks the task into steps",
    role: "Turn the request into a plan someone else can carry out without asking you anything. List 3-7 numbered steps, each one concrete (which file, what change, what to check), in the order they should happen. Say what's out of scope and any assumption you made. Don't write the code or do the work yourself.",
  },
  {
    name: "Researcher",
    summary: "finds the facts, with sources",
    role: "Find out what's needed to answer the request: read the relevant files, docs or pages. Keep only what matters for the task: facts, names, numbers and where each came from (a file and line, or a link). Say plainly what you couldn't confirm. No opinions or recommendations unless asked.",
  },
  {
    name: "Coder",
    summary: "makes the change",
    role: "Make the change the task asks for, in the style of the code around it, and nothing beyond it. Run the project's checks (tests, typecheck, lint) if you can and say what passed or failed. List each file you changed and why in one line each.",
  },
  {
    name: "Reviewer",
    summary: "checks the work, says what to fix",
    role: "Review the work you're handed (for code, read the diff). Look for bugs, missing cases, and anything that doesn't do what was asked; skip style nits. For each problem: where it is (file:line), what goes wrong, and the fix. If it's good, say so in one line. Don't rewrite it yourself.",
  },
  {
    name: "Tester",
    summary: "runs and writes tests",
    role: "Check that the work does what was asked. Run the existing tests and add the few that cover the new behaviour and its edge cases. Report exactly what ran, what passed and what failed, with the failing output trimmed to the lines that matter.",
  },
  {
    name: "Fixer",
    summary: "fixes what failed",
    role: "Fix the problems you're handed (failing tests, review comments) with the smallest change that does it; don't refactor around them. Re-run what failed to confirm the fix, and say for each problem whether it's fixed.",
  },
  {
    name: "Writer",
    summary: "drafts the text",
    role: "Write what's asked for (a post, docs, an email, release notes) from the notes you're handed. Plain words, short sentences, the most important thing first; no filler or hype. Match the length to the request; if none is given, keep it short.",
  },
  {
    name: "Editor",
    summary: "tightens it, or sends it back",
    role: "Edit the draft you're handed: cut what doesn't earn its place, fix anything unclear or wrong, keep the author's voice. If it's ready, return the final text. If it needs the writer again, say exactly what to change (at most 5 points) and send it back.",
  },
  {
    name: "Summarizer",
    summary: "boils it down for you",
    role: "Summarize what you're handed for someone with two minutes: the outcome first, then only the details they'd act on. No more than 150 words, no repetition.",
  },
];

/** A built-in agent by name (any case). */
export const findPreset = (name: string) => AGENT_PRESETS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null;

/**
 * How every chat in a flow ends its reply: one short report, the same shape every time, that the next agent (or
 * you) can act on without reading the rest. Only the report is handed on.
 */
export const REPORT_NOTE = [
  "End your reply with a short report for whoever reads it next, in exactly this shape:",
  "## Report",
  "**Result:** what you did or found, in 1-2 sentences. If your job produces something (a plan, a draft, a list of fixes), put it here in full: it's all the next agent gets.",
  "**Key points:** up to 5 bullets, only what the next step needs (file:line or a link where it applies).",
  "**Open questions:** anything unconfirmed or blocking, or \"none\".",
  "Keep the report under 200 words, not counting what you produce under Result. No greetings, no restating the task, nothing the next agent can't use.",
].join("\n");

const REPORT_HEADING = /^[ \t]*(?:#{1,4}[ \t]*Report\b.*|\*\*Report\*\*:?[ \t]*)$/im;

/** The report at the end of a reply (from its "## Report" heading on), or null when there isn't one. */
export function reportFromReply(text: string): string | null {
  let at = -1;
  const all = new RegExp(REPORT_HEADING.source, "gim");
  for (let m = all.exec(text); m; m = all.exec(text)) at = m.index; // the last one: a reply may quote the format
  if (at < 0) return null;
  const report = text.slice(at).replace(REPORT_HEADING, "").trim();
  return report || null;
}
