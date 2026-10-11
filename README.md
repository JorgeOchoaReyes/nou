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
  <img src="https://img.shields.io/badge/OpenRouter%20·%20Groq%20·%20DeepSeek-cloud-bb9af7?style=flat-square&labelColor=1a1b26" alt="More providers">
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
| 🔀 **Live diffs** | Every edit Nou proposes shows up side by side. <kbd>y</kbd> accepts, <kbd>n</kbd> rejects. Nothing touches disk without you. |
| ✍️ **Built-in editor** | Press <kbd>e</kbd> to edit the open file yourself, with undo/redo and **auto-save**. |
| ↶ **Undo anything** | Every change, Nou's or yours, is recorded. <kbd>u</kbd> undoes Nou's last edit, `/rewind` undoes its whole last turn, and your own later edits are kept. |
| 🧾 **Session diffs** | `/diff` shows everything that changed this session, file by file (<kbd>[</kbd> <kbd>]</kbd> to step through). `/sessions` lists earlier sessions and `/diff 2` shows one. |
| 🩺 **Problems, live** | Syntax errors instantly, plus ESLint, TypeScript, Ruff and language servers when your project has them. Shown in the gutter, inline, and in a <kbd>p</kbd> Problems panel. |
| 🤖 **Self-correcting** | Nou checks its own edits: you see "⚠ +1 problem" *before* approving, and any problems it introduced are fed back so it fixes them. |
| 🎨 **Real syntax highlighting** | tree-sitter parsing for 14 languages (TS, JS, Python, Go, Rust, Java, C, JSON, YAML…). |
| 🧭 **Code intelligence** | <kbd>Ctrl</kbd>+<kbd>K</kbd> hover info and <kbd>Ctrl</kbd>+<kbd>G</kbd> go-to-definition via language servers (typescript-language-server, pyright, rust-analyzer, gopls, clangd). |
| 👀 **Knows what you're looking at** | The open file, visible lines, your cursor and unsaved edits ride along with each message. "Fix this function" just works. |
| 🌿 **Git aware** | Sees your branch, uncommitted changes and recent commits, and can diff on its own. Press <kbd>v</kbd> to diff any file against `HEAD`. |
| 🔌 **Any model** | Local (Ollama, LM Studio, llama.cpp) or cloud (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek). Switch mid-conversation. |
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
| 🖱️ Mouse | wheel scrolls the pane under the pointer · click a pane to focus it · click a file to open it (hold <kbd>Shift</kbd> to select text; turn off in settings) |
| <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>PgUp</kbd>/<kbd>PgDn</kbd> | scroll the chat history |
| <kbd>Tab</kbd> | switch between files, code and chat |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | fuzzy-find a file |
| <kbd>e</kbd> | edit the open file (<kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo · <kbd>Ctrl</kbd>+<kbd>K</kbd> info · <kbd>Ctrl</kbd>+<kbd>G</kbd> definition · <kbd>Esc</kbd> close) |
| <kbd>p</kbd> | Problems panel: every error and warning, <kbd>Enter</kbd> jumps to it |
| <kbd>u</kbd> | undo Nou's last edit |
| <kbd>v</kbd> | diff the open file vs git `HEAD`, Nou's last edit, or this session · <kbd>n</kbd>/<kbd>N</kbd> jump between changes · <kbd>[</kbd>/<kbd>]</kbd> previous/next file in a session diff |
| <kbd>c</kbd> | in the file tree: show only changed files |
| <kbd>f</kbd> | follow mode: jump to files as Nou reads and edits them |
| <kbd>s</kbd> | settings: model, preferences, plugins |
| <kbd>y</kbd> / <kbd>n</kbd> | accept / reject a proposed edit or command |
| <kbd>Esc</kbd> | stop Nou · close a diff · back to chat |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | stop Nou while it works · press twice to quit |

Chat commands: `/settings` · `/model [provider:model]` · `/models [provider]` · `/pull <model>` · `/undo` · `/rewind` · `/history` · `/diff [file or n]` · `/sessions` · `/problems` · `/clear` · `/help`

## 🧠 Models

Pick one in <kbd>s</kbd> settings, with `/model anthropic` or `/model ollama:qwen3:8b`, or set `NOU_MODEL=provider:model`. Switching to an Ollama model you don't have downloads it (or use `/pull <model>`). API keys come from your environment or a `.env` file in your project; see [.env.example](.env.example).

If you haven't set a key, Nou uses the API key from Claude Code (`~/.claude/settings.json`) or Codex (`~/.codex/auth.json`). Subscription sign-ins (claude.ai, ChatGPT) can't be reused. Turn this off in settings with "Use Claude Code / Codex keys".

<details>
<summary><b>All providers and how to set them up</b></summary>

| Provider | Type | Setup |
| --- | --- | --- |
| 🦙 Ollama *(default)* | 🟢 local | runs locally · `OLLAMA_HOST` to change |
| 🖥️ LM Studio | 🟢 local | start its local server |
| ⚙️ llama.cpp server | 🟢 local | start `llama-server` |
| 🔧 Any OpenAI-compatible server | 🟢 local | `NOU_BASE_URL`, optional `NOU_API_KEY` |
| 🟣 Anthropic (Claude) | ☁️ cloud | `ANTHROPIC_API_KEY` |
| ⚪ OpenAI | ☁️ cloud | `OPENAI_API_KEY` |
| 🔷 Google Gemini | ☁️ cloud | `GEMINI_API_KEY` |
| 🔀 OpenRouter | ☁️ cloud | `OPENROUTER_API_KEY` |
| ⚡ Groq | ☁️ cloud | `GROQ_API_KEY` |
| 🐋 DeepSeek | ☁️ cloud | `DEEPSEEK_API_KEY` |

</details>

## 🔄 Updating

Nou checks npm once a day and offers to update when a new version is out (one keypress, then it restarts itself). Or run it yourself:

```bash
nou update          # or: npm install -g nou-cli@latest
nou --version
```

Set `NOU_NO_UPDATE_CHECK=1` to turn the check off.

## 🧩 Plugins *(early)*

Drop a `.js` / `.mjs` file into `.nou/plugins/` (this project) or `~/.nou/plugins/` (everywhere), then switch it on in <kbd>s</kbd> settings → **Plugins**. A plugin can give the model new tools, add slash commands, add to the system prompt, and add **checkers** (linters) whose problems show in the editor. The built-in ESLint, TypeScript, Ruff, syntax and language-server checkers are plugins too, so you can switch any of them off.

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
```

Releasing: bump `version` in `package.json`, merge to `master`, then run **Actions → Publish to npm**. It tests, publishes with provenance, and creates the git tag and GitHub Release. (Or publish a GitHub release tagged `vX.Y.Z`.) The token lives in the `production` environment as `NPM_TOKEN`.

Upkeep runs on its own:
- **CI** on every PR: type-check, lint, build, unit and end-to-end tests on Linux, macOS and Windows (Node 22.12 and 24 too), plus installing the packed tarball to check the package works.
- **Dependabot** opens weekly PRs for dependency and GitHub Actions updates.
- **CodeQL** scans for security issues on every PR and weekly.
- **npm audit** fails CI if a dependency users install has a high-severity vulnerability.

<p align="center"><sub>Made with 🌞 by <a href="https://github.com/JorgeOchoaReyes">Jorge Ochoa-Reyes</a></sub></p>
