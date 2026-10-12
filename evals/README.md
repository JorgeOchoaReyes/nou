# Evals

How well does Nou's agent actually do coding tasks, with a given model? The unit and e2e tests check the harness with scripted models. Evals run **real models** on small tasks and check the result.

```bash
npm run eval                                        # NOU_MODEL, or local Ollama
npm run eval -- --model ollama:qwen3:8b --model anthropic --repeat 3
npm run eval -- --task fix-failing-test --keep      # keep the project folder to look at
```

Each run prints pass/fail per task with steps, time and tools used, then a summary per model. Results are saved to `evals/results/` (gitignored), so you can compare before and after a change to the prompt, tools or a provider.

> [!WARNING]
> Everything the model does is auto-approved, **including shell commands**. Each task runs in its own temporary folder, but run evals on a machine or container you don't mind a model running commands on.

## How it works

- Each task (in [`tasks.ts`](tasks.ts)) is a small project, a request in plain words, and a **hidden check** that runs after the model is done. The model never sees the check, so passing means the work is right.
- The agent is the real one with the same tools, plugins and problem checks as the app (see [`src/agent/harness.ts`](../src/agent/harness.ts)). Git context is off because the projects aren't repos.
- `npm test` makes sure every check fails the untouched project and passes a correct solution, so a broken check can't make a model look good.

## The tasks

| Task | Tests |
| --- | --- |
| `fix-failing-test` | debug from a failing test, without changing the test |
| `implement-from-spec` | write a function from a spec, edge cases included |
| `rename-across-files` | one consistent change across several files |
| `edit-large-file` | change one line in a 3000-line file and leave the rest alone |
| `find-the-setting` | find where something lives in an unfamiliar project |
| `answer-without-editing` | answer a question without touching any files |

## Adding a task

Add an entry to `TASKS` in `tasks.ts` with its `files`, a `prompt` and a `check` that returns `null` on success or a reason. Then add a reference solution in the "Evals" section of `tests/unit.ts`. Good tasks are small, have one clearly right outcome, and target a single skill. Make checks test behavior (run the code) rather than exact text, so any correct solution passes.

Run each task a few times (`--repeat`): models aren't deterministic, and one run says little.
