<p align="center">
  <img src="https://raw.githubusercontent.com/JorgeOchoaReyes/nou/HEAD/docs/banner.svg" alt="Nou: your AI coding companion, right in the terminal" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nou-cli"><img src="https://img.shields.io/npm/v/nou-cli?style=for-the-badge&color=bb9af7&labelColor=1a1b26&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/JorgeOchoaReyes/nou/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JorgeOchoaReyes/nou/ci.yml?branch=master&style=for-the-badge&label=CI&labelColor=1a1b26&color=9ece6a&logo=githubactions&logoColor=white" alt="CI"></a>
  <img src="https://img.shields.io/node/v/nou-cli?style=for-the-badge&color=7dcfff&labelColor=1a1b26&logo=nodedotjs&logoColor=white" alt="node version">
  <img src="https://img.shields.io/npm/l/nou-cli?style=for-the-badge&color=e0af68&labelColor=1a1b26" alt="license">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Ollama-local-9ece6a?style=flat-square&logo=ollama&logoColor=white&labelColor=1a1b26" alt="Ollama">
  <img src="https://img.shields.io/badge/LM%20Studio-local-9ece6a?style=flat-square&labelColor=1a1b26" alt="LM Studio">
  <img src="https://img.shields.io/badge/Claude-cloud-bb9af7?style=flat-square&logo=anthropic&logoColor=white&labelColor=1a1b26" alt="Claude">
  <img src="https://img.shields.io/badge/OpenAI-cloud-bb9af7?style=flat-square&labelColor=1a1b26" alt="OpenAI">
  <img src="https://img.shields.io/badge/Gemini-cloud-bb9af7?style=flat-square&logo=googlegemini&logoColor=white&labelColor=1a1b26" alt="Gemini">
  <img src="https://img.shields.io/badge/OpenRouter%20·%20Groq%20·%20DeepSeek%20·%20Fireworks%20·%20LiteLLM-cloud-bb9af7?style=flat-square&labelColor=1a1b26" alt="More providers">
</p>

<p align="center">
  <b>An IDE that lives in your terminal.</b> Browse your code, watch the AI's edits as live side-by-side diffs,<br>
  approve them with a keypress, edit files yourself, and switch between local and cloud models on the fly.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/JorgeOchoaReyes/nou/HEAD/docs/screenshot.svg" alt="Nou proposing an edit as a side-by-side diff, with the file tree and chat" width="100%">
</p>

---

## ⚡ Quick start

```bash
npm install -g nou-cli
cd your-project
nou
```

> [!TIP]
> Want it fully local and free? Just run `nou`: if Ollama or its model (`qwen3:8b`) is missing, Nou offers to install and download them. Already using Claude Code or Codex with an API key, or have Ollama models or LM Studio? Nou finds them on first run and lets you pick.

Needs **Node 22.12+** and an interactive terminal (Windows Terminal, PowerShell, macOS/Linux terminals).

## ✨ What it does

| | |
| --- | --- |
| 🗂️ **File explorer** | Browse your project with file icons and git status (`M` modified, `?` new). Press <kbd>c</kbd> to see only changed files. |
| 🔀 **Live diffs** | Every edit Nou proposes shows up side by side, and the files it is editing shimmer in the file tree while it works. <kbd>y</kbd> accepts, <kbd>n</kbd> rejects. Nothing touches disk without you. |
| ✍️ **Built-in editor** | Press <kbd>e</kbd> to edit the open file yourself, with undo/redo and **auto-save**. |
| 📍 **Shows you where things are** | Ask "where is the LiveKit integration?" and Nou finds it and opens it in the middle panel, jumped to the exact lines and highlighted. Any file a reply mentions (`src/a.ts:12`) is a link: click it. `/open name[:line]` opens a file yourself. |
| 🎮 **Games for a break** | Add Pong, Snake and Breakout in settings → Games, then `/games` opens a panel docked under the chat: it splits that column instead of covering anything. Drag its title onto the files, code or chat to dock it there, and × at its top right closes it. A game runs only while the panel has the keyboard: Esc goes back to your code and it waits. |
| 🧠 **A capable engine** | Reads and searches in parallel, numbered reads for exact line references, edits that survive small whitespace mismatches, several edits to a file as one change, a plan for longer tasks, full command output (stderr too) with exit codes and timeouts, retries when a provider is overloaded or a connection drops (Codex too: it picks the turn back up instead of stopping at "Reconnecting..."), and conversation caching with Claude. It follows your repo's `AGENTS.md`, `CLAUDE.md` and `NOU.md` (and `~/.nou/NOU.md`). |
| 🔎 **Finds its way around** | The agent searches your code (`grep`, `glob`) without asking, reads only what it needs, runs your tests to check its work, and summarizes long conversations to stay within the model's context (`/compact` does it on demand). |
| ↶ **Undo anything** | Every change, Nou's or yours, is recorded. <kbd>u</kbd> undoes Nou's last edit, `/rewind` undoes its whole last turn, and your own later edits are kept. |
| 🧾 **Session diffs** | `/diff` shows everything that changed this session, file by file (<kbd>[</kbd> <kbd>]</kbd> to step through). `/sessions` lists earlier sessions and `/diff 2` shows one. |
| 🩺 **Problems, live** | Syntax errors instantly, plus ESLint, TypeScript, Ruff and language servers when your project has them. Shown in the gutter, inline, and in a <kbd>p</kbd> Problems panel. |
| 🤖 **Self-correcting** | Nou checks its own edits: you see "⚠ +1 problem" *before* approving, and any problems it introduced are fed back so it fixes them. |
| 🎨 **Real syntax highlighting** | tree-sitter parsing for 14 languages (TS, JS, Python, Go, Rust, Java, C, JSON, YAML…), in your choice of theme: One Dark (default), Tokyo Night, GitHub Dark, Dracula, High Contrast or GitHub Light (settings → Preferences → Code colors, with a preview). |
| 🧭 **Code intelligence** | <kbd>Ctrl</kbd>+<kbd>K</kbd> hover info and <kbd>Ctrl</kbd>+<kbd>G</kbd> go-to-definition via language servers (typescript-language-server, pyright, rust-analyzer, gopls, clangd). |
| 👀 **Knows what you're looking at** | The open file, visible lines, your cursor and unsaved edits ride along with each message. "Fix this function" just works. |
| 🌿 **Git aware** | Sees your branch, uncommitted changes and recent commits, and can diff on its own. Press <kbd>v</kbd> to diff any file against `HEAD`. |
| 🔌 **Any model** | Local (Ollama, LM Studio, llama.cpp) or cloud (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek). Switch mid-conversation. |
| 🛞 **Pick your agent** | Nou's own, or Claude Code, Codex or pi, switchable like models, with the same diffs, approvals and undo. |
| 🧩 **Plugins** | Add your own tools and slash commands with a single file. |
| 🔎 **Quick open** | <kbd>Ctrl</kbd>+<kbd>P</kbd> fuzzy-finds any file. |

Every change is reviewed like a code review:

```diff
 function resolveInProject(filePath: string): string {
-  const fullPath = path.resolve(process.cwd(), filePath);
+  const root = realpathSync(process.cwd());
+  const fullPath = path.resolve(root, filePath);
```

## ⌨️ Keys

| Key | Does |
| --- | --- |
| 🖱️ Mouse | wheel scrolls the pane under the pointer (<kbd>Shift</kbd>+wheel or a tilt wheel: sideways) · click or drag a scrollbar to jump · click a file to open it · **double-click in the code to edit right there** (in the editor: select a word), drag to select · drag a border between panes to resize them (press <kbd>m</kbd> to turn the mouse off and select text in your terminal) |
| <kbd>PgUp</kbd>/<kbd>PgDn</kbd>, <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> | scroll the chat; scrolled up, new replies wait below instead of yanking the view (<kbd>Ctrl</kbd>+<kbd>End</kbd> jumps back) |
| <kbd>?</kbd> | **every action, searchable**, each with its shortcut (also <kbd>Ctrl</kbd>+<kbd>P</kbd> then `>`) |
| <kbd>/</kbd> | start a command from any pane: a menu lists every command with what it does (<kbd>↑</kbd>/<kbd>↓</kbd> choose, <kbd>Tab</kbd> complete, <kbd>Enter</kbd> run) |
| 🖱️ Status bar | click the mode to switch it, `follow` to toggle it, the ✖/▲ counts for the Problems panel, or any shortcut hint to do it · click the model in the header to change it |
| <kbd>Tab</kbd> | switch between files, code and chat |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | ask → auto-edit (edits apply without asking) → auto (commands too); everything stays undoable |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | fuzzy-find a file; the files you've opened are listed first |
| <kbd>b</kbd> | back to the previous file (press again to flip back) |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | find in the open file: matches are highlighted and counted; <kbd>Enter</kbd>/<kbd>↓</kbd> next, <kbd>↑</kbd> previous, <kbd>Esc</kbd> close |
| 🗂️ Tabs | every file you open gets a tab over the code: click one to switch, any tab's × to close it, ‹ › for ones that don't fit · <kbd>[</kbd>/<kbd>]</kbd> previous/next · <kbd>x</kbd> or <kbd>Ctrl</kbd>+<kbd>W</kbd> close |
| <kbd>Ctrl</kbd>+click | on a name in the code (or <kbd>Option</kbd>+click, or right-click): go to its definition; an imported name goes to its import, and the import's path opens that file |
| <kbd>e</kbd> or a double-click | edit the open file (see the editor keys below) |
| <kbd>p</kbd> | Problems panel: every error and warning, <kbd>Enter</kbd> jumps to it |
| <kbd>u</kbd> | undo Nou's last edit |
| <kbd>v</kbd> | diff the open file vs git `HEAD`, Nou's last edit, or this session · <kbd>n</kbd>/<kbd>N</kbd> jump between changes · <kbd>[</kbd>/<kbd>]</kbd> previous/next file in a session diff |
| <kbd>c</kbd> | in the file tree: show only changed files |
| <kbd>f</kbd> | follow mode (off by default): watch along as Nou works. Each file it reads (the exact lines, highlighted) is shown a step at a time, a little behind it, and its edits as they happen. The status bar shows how many steps behind it is; set the speed in settings → Preferences (slow · normal · fast · instant) |
| <kbd>&lt;</kbd> / <kbd>&gt;</kbd> / <kbd>=</kbd> | make the focused pane narrower / wider / reset the layout |
| <kbd>`</kbd> | a terminal under the code, like VS Code's (also `/terminal`): Enter runs a command, Ctrl+C stops it, ↑↓ history, Esc back to the code, × closes it. Commands run through your shell one at a time, so full-screen programs like vim don't draw there |
| <kbd>m</kbd> | mouse on/off, so you can select and copy text in the terminal (in the chat, just drag over the text: it's copied when you let go) |
| <kbd>s</kbd> | settings: model, preferences, plugins |
| <kbd>y</kbd> / <kbd>n</kbd> | accept / reject a proposed edit or command, from any pane; the rest of Nou keeps working while it waits (<kbd>o</kbd> shows the edit) |
| <kbd>Enter</kbd> while Nou works | queue the message: it goes when Nou finishes (<kbd>Alt</kbd>+<kbd>Enter</kbd>: stop Nou and send it now) |
| <kbd>Esc</kbd> | stop Nou (anything queued goes back in the input) · close a diff · back to chat |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | stop Nou while it works · press twice to quit |

In the editor:

| Key | Does |
| --- | --- |
| <kbd>Shift</kbd>+arrows, <kbd>Shift</kbd>+<kbd>Home</kbd>/<kbd>End</kbd>, mouse drag | select · <kbd>Ctrl</kbd>+<kbd>A</kbd> select all |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> | copy / cut / paste (the whole line when nothing is selected); your terminal's own paste works too |
| <kbd>Ctrl</kbd>+<kbd>←</kbd>/<kbd>→</kbd>, <kbd>Ctrl</kbd>+<kbd>Backspace</kbd> or <kbd>Ctrl</kbd>+<kbd>W</kbd> | move by word, delete a word · <kbd>Ctrl</kbd>+<kbd>Home</kbd>/<kbd>End</kbd> start / end of the file |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> · <kbd>Ctrl</kbd>+<kbd>L</kbd> | find (<kbd>Enter</kbd>/<kbd>↓</kbd> next, <kbd>Shift</kbd>+<kbd>Enter</kbd>/<kbd>↑</kbd> previous) · go to line |
| <kbd>Ctrl</kbd>+<kbd>/</kbd> · <kbd>Ctrl</kbd>+<kbd>D</kbd> · <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> | comment the line or selection · duplicate it · move it up / down |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | indent / outdent (whole lines with a selection) · <kbd>Enter</kbd> keeps the indent, one more after `{`, `(`, `[` |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> · <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> | save (auto-save is on by default) · undo / redo |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> · <kbd>Ctrl</kbd>+<kbd>G</kbd> | hover info · go to definition (with a language server) |
| <kbd>Esc</kbd> | clear the selection, or leave the editor |

Chat commands: `/settings` · `/model [provider:model]` · `/models [provider]` · `/pull <model>` · `/engine [name]` · `/auto [ask|auto-edit|auto]` · `/copy [code|file]` · `/undo` · `/rewind` · `/history` · `/diff [file or n]` · `/sessions` · `/problems` · `/compact` · `/clear` · `/resume [n|last]` · `/terminal` · `/help`

New lines in a message: <kbd>Shift</kbd>/<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> in terminals that report them (kitty, Ghostty, WezTerm, iTerm2 and others with the kitty keyboard protocol), or type `\` and press <kbd>Enter</kbd> in any terminal.

Conversations are saved per folder after each reply. `/resume` lists them and `/resume 2` (or `nou --continue` for the last one, `nou --resume` for the list) picks one back up with the engine it was on: Nou's own engine restores its messages, Claude Code its session and Codex its thread; pi is handed the conversation so far. Sessions you started in Claude Code's or Codex's own CLI in this folder are listed too (marked "CLI"), and resuming one carries it on in that engine inside Nou.

## 🧠 Models

Pick one in <kbd>s</kbd> settings, with `/model anthropic` or `/model ollama:qwen3:8b`, or set `NOU_MODEL=provider:model`. Switching to an Ollama model you don't have downloads it (or use `/pull <model>`). API keys come from your environment or a `.env` file in your project; see [.env.example](.env.example). Or connect a provider inside Nou: pick it in <kbd>s</kbd> settings and press <kbd>Enter</kbd>, or run `/connect fireworks`, then paste your key. It's saved to `~/.nou/credentials.json` (only you can read it) and works right away, no restart. If a key is rejected, settings says where it came from (your shell, `.env`, or Claude Code's or Codex's settings); press <kbd>k</kbd> to enter another.

If you haven't set a key, Nou uses the API key from Claude Code (`~/.claude/settings.json`) or Codex (`~/.codex/auth.json`). Subscription sign-ins (claude.ai, ChatGPT) can't be reused. Turn this off in settings with "Use Claude Code / Codex keys".

<details>
<summary><b>All providers and how to set them up</b></summary>

| Provider | Type | Setup |
| --- | --- | --- |
| 🦙 Ollama *(default)* | 🟢 local | runs locally · `OLLAMA_HOST` to change |
| 🖥️ LM Studio | 🟢 local | start its local server |
| ⚙️ llama.cpp server | 🟢 local | start `llama-server` |
| 🔧 Any OpenAI-compatible server | 🟢 local | `NOU_BASE_URL`, optional `NOU_API_KEY` |
| 🚅 LiteLLM proxy or any hosted gateway | ☁️ cloud | `/connect litellm`, or `LITELLM_BASE_URL` + `LITELLM_API_KEY` (LiteLLM's `LITELLM_PROXY_API_BASE` + `LITELLM_PROXY_API_KEY` work too) |
| 🟣 Anthropic (Claude) | ☁️ cloud | `ANTHROPIC_API_KEY` |
| ⚪ OpenAI | ☁️ cloud | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |
| 🔷 Google Gemini | ☁️ cloud | `GEMINI_API_KEY` |
| 🔀 OpenRouter | ☁️ cloud | `OPENROUTER_API_KEY` |
| ⚡ Groq | ☁️ cloud | `GROQ_API_KEY` |
| 🐋 DeepSeek | ☁️ cloud | `DEEPSEEK_API_KEY` |
| 🎆 Fireworks AI | ☁️ cloud | `/connect fireworks`, or `FIREWORKS_API_KEY` |

Every cloud provider can also be connected from inside Nou with `/connect <provider>`.

**Local or cloud?** Nou keeps less conversation for local models (about 90k characters) before summarizing, since they usually run with a small context window. The `custom` provider is meant for servers on your machine (vLLM, Jan, LocalAI...). For a LiteLLM proxy, or any other OpenAI-compatible gateway in front of cloud models, use `litellm`: it gets the full cloud budget. Override either with `NOU_CONTEXT_CHARS`.

</details>

## 🛞 Engines

The engine is the agent that answers in the chat. Nou's own works with every model; you can switch to another one any time, like switching models: <kbd>s</kbd> settings → **Engine**, or `/engine <name>`. Diffs, approvals, undo and the problems panel work with all of them.

| Engine | Models | Asks before edits and commands |
|:--|:--|:--:|
| `nou` *(default)* | any | ✅ |
| `claude-code` (Claude Agent SDK) | Claude; your API key or Claude login | ✅ |
| `pi` | your Nou model, local or cloud | ✅ |
| `codex` (Codex SDK) | OpenAI; your API key or ChatGPT login | ❌ edits in its sandbox; review and undo after |

Other engines install on first use into `~/.nou/engines/`, so Nou itself stays small. Switching engines starts a new conversation. Compare them on the same tasks with `npm run eval -- --engine nou --engine claude-code`.

## 🔄 Updating

Nou checks npm once a day and offers to update when a new version is out (one keypress, then it restarts itself). Or run it yourself:

```bash
nou update          # or: npm install -g nou-cli@latest
nou --version
```

Set `NOU_NO_UPDATE_CHECK=1` to turn the check off.

## 🔌 MCP servers and browser control

Nou's engine can use tools from [MCP](https://modelcontextprotocol.io) servers: a browser, GitHub, your database...

- **Already use some?** Nou finds the MCP servers you've set up in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI and Codex, and offers them on start: `/mcp import` brings them over, with their settings. (Your Claude Code and Codex API keys are picked up too; see *Use Claude Code / Codex keys* in settings.)
- **Browser control:** `/mcp add browser` adds [Playwright's MCP server](https://github.com/microsoft/playwright-mcp), so you can ask Nou to open a page, click through it, fill a form or check what your app shows.
- **Your own:** `/mcp add <name> <command and arguments>` or `/mcp add <name> <url>`; `/mcp` lists them and their status, `/mcp remove <name>` removes one. They live in `~/.nou/mcp.json` (same format as Claude Code and Cursor); a project's `.mcp.json` is used too, in folders you trust.

Tools that say they only read run on their own; any other MCP tool asks you first, like Nou's edits and commands. A server's own output never reaches Nou's screen.

## 🔒 Trusting a folder

The first time you open a folder, Nou asks whether you trust its files: it reads them, and can run the folder's MCP servers and plugins. Say no and Nou doesn't open it. Trusted folders are listed in `~/.nou/config.json`.

## 🧩 Plugins *(early)*

**Starter plugins** ship with Nou and are optional: open <kbd>s</kbd> settings → **Plugins** and press Enter on one, or type `/plugins add <name>`. Adding one copies it into `~/.nou/plugins/`, where it's yours to edit.

| Starter | What it adds |
|:--|:--|
| `run-tests` | `run_tests` tool and `/test`. Works out npm / pnpm / yarn / bun, cargo, go, pytest or make (asks before each run). |
| `todos` | `find_todos` tool and `/todos`: TODO / FIXME / HACK comments with file:line. |
| `fetch-url` | `fetch_url` tool so the model can read docs and web pages (asks before each URL). |
| `project-rules` | Feeds `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and Copilot instructions to the model; `/rules` lists them. |

**Write your own:** `/plugins new <name>` creates a commented `.nou/plugins/<name>.mjs` to fill in. `/plugins` lists what you have. Or drop a `.js` / `.mjs` file into `.nou/plugins/` (this project) or `~/.nou/plugins/` (everywhere), then switch it on in <kbd>s</kbd> settings → **Plugins**. A plugin can give the model new tools, add slash commands, add to the system prompt, and add **checkers** (linters) whose problems show in the editor. The built-in ESLint, TypeScript, Ruff, syntax and language-server checkers are plugins too, so you can switch any of them off.

```js
export default {
  name: "word-count",
  tools: [{ readOnly: true, definition: { name: "word_count", /* ... */ }, run: (args) => "42 words" }],
  commands: [{ name: "wc", description: "Count words", run: (args) => "42 words" }],
  diagnostics: [{
    id: "todo", name: "TODOs", checksText: true, matches: (f) => f.endsWith(".ts"), available: () => true,
    check: async (file, text) => text.split("\n").flatMap((l, i) => l.includes("TODO")
      ? [{ file, line: i + 1, col: 1, severity: "info", message: "TODO left here", source: "todo" }] : []),
  }],
};
```

Full example: [examples/plugins/word-count.mjs](examples/plugins/word-count.mjs).

> [!WARNING]
> Plugins run code on your machine, so they stay **off** until you enable them.

## 🛠️ Development

```bash
npm install
npm run dev          # run from source
npm run build        # compile to dist/ (and copy the syntax grammars)
npm test             # end-to-end tests: drives the real UI with simulated keys
npm run screenshot   # regenerate docs/screenshot.svg
npm run eval         # how well the agent does real tasks with a real model (see evals/)
```

### Releasing

**Always bump the version first.** npm never accepts the same version twice, so publishing without a bump fails with *"nou-cli@X.Y.Z is already published. Bump "version" in package.json first."* Every release goes:

1. **Bump the version** in a PR: `npm version patch --no-git-tag-version` (or `minor` / `major`), which updates `package.json` and `package-lock.json` together. Patch (0.5.1 → 0.5.2) for fixes and small features, minor (0.5 → 0.6) for bigger ones.
2. **Merge it** to `master` once CI is green.
3. **Run Actions → Publish to npm** (Run workflow on `master`), then **approve** the `production` environment when GitHub asks. It tests, publishes with provenance, and creates the `vX.Y.Z` git tag and GitHub Release. (Publishing a GitHub release tagged `vX.Y.Z` does the same, taking the version from the tag.)

The npm token lives in the `production` environment as `NPM_TOKEN`. Check what's live with `npm view nou-cli version`.

The workflows run on the actions' Node 24 versions (`actions/checkout@v5`, `actions/setup-node@v5`, `codeql-action@v4`), so GitHub's Node 20 deprecation warning no longer applies; Dependabot keeps them current. Jobs run on `ubuntu-latest`, which GitHub moves to Ubuntu 26 from October 19, 2026: nothing to change for that.

Upkeep runs on its own:
- **CI** on every PR: type-check, lint, build, unit and end-to-end tests on Linux, macOS and Windows (Node 22.12 and 24 too), plus installing the packed tarball to check the package works.
- **Dependabot** opens weekly PRs for dependency and GitHub Actions updates.
- **CodeQL** scans for security issues on every PR and weekly.
- **npm audit** fails CI if a dependency users install has a high-severity vulnerability.

<p align="center"><sub>Made with 🌞 by <a href="https://github.com/JorgeOchoaReyes">Jorge Ochoa-Reyes</a></sub></p>
