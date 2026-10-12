# Roadmap

Work in progress and ideas, roughly in priority order. Agent changes are measured with the evals
(`npm run eval`, see [evals/README.md](evals/README.md)).

## Agent quality

- **`edit-large-file` regression.** With the new prompt and tools, local `qwen3:8b-24k` scored 0/2 on it
  (1/2 before). One run read the 3,000-line file page by page instead of using `grep`, then replaced a
  large block, changing other lines; the other replied without using any tools. Failed runs now print
  the model's last reply; rerun with
  `npm run eval -- --model ollama:qwen3:8b-24k --task edit-large-file --repeat 3 --keep` to see why, then
  fix it (prompt, or a nudge when the agent stops without making a change it was asked for).
- **`implement-from-spec` (1/2).** The model wrote buggy code without trying it. The prompt now says to try
  new code on the user's examples when there are no tests; this hasn't been measured yet.
- **Finish measuring this round.** Last run, 8 of 12 runs done before stopping: fix-failing-test 2/2,
  implement-from-spec 1/2, rename-across-files 2/2 (was failing), edit-large-file 0/2,
  find-the-setting 2/2; answer-without-editing not run yet.

## Engines

- **Live-test pi** with a local model (Ollama). Claude Code has been tested live; pi and Codex only
  against fake SDKs in the tests.
- **Live-test Codex** once signed in (`codex login`). Without a login it reports that clearly.
- **Compare engines** on the evals: `npm run eval -- --engine nou --engine claude-code --engine pi`.
- Give external engines Nou's plugin tools (Claude Code via an in-process MCP server, pi via custom tools).

## Ideas

- Conversation history that survives restarts.
- More starter plugins.
