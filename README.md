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
> Want it fully local and free? Install [Ollama](https://ollama.com), run `ollama pull qwen3:8b`, and you're set. That's the default model.

Needs **Node 20.12+** and an interactive terminal (Windows Terminal, PowerShell, macOS/Linux terminals).

## ✨ What it does

| | |
| --- | --- |
| 🗂️ **File explorer** | Browse your project with file icons and git status (`M` modified, `?` new). Press <kbd>c</kbd> to see only changed files. |
| 🔀 **Live diffs** | Every edit Nou proposes shows up side by side. <kbd>y</kbd> accepts, <kbd>n</kbd> rejects. Nothing touches disk without you. |
| ✍️ **Built-in editor** | Press <kbd>e</kbd> to edit the open file yourself: <kbd>Ctrl</kbd>+<kbd>S</kbd> save, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo. |
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
| <kbd>Tab</kbd> | switch between files, code and chat |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | fuzzy-find a file |
| <kbd>e</kbd> | edit the open file (<kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> close) |
| <kbd>v</kbd> | diff the open file vs git `HEAD` (or Nou's last edit) · <kbd>n</kbd>/<kbd>N</kbd> jump between changes |
| <kbd>c</kbd> | in the file tree: show only changed files |
| <kbd>f</kbd> | follow mode: jump to files as Nou reads and edits them |
| <kbd>s</kbd> | settings: model, preferences, plugins |
| <kbd>y</kbd> / <kbd>n</kbd> | accept / reject a proposed edit or command |
| <kbd>Esc</kbd> | stop Nou · close a diff · back to chat |

Chat commands: `/settings` · `/model [provider:model]` · `/models [provider]` · `/clear` · `/help`

## 🧠 Models

Pick one in <kbd>s</kbd> settings, with `/model anthropic` or `/model ollama:qwen3:8b`, or set `NOU_MODEL=provider:model`. API keys come from your environment or a `.env` file in your project; see [.env.example](.env.example).

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

## 🧩 Plugins *(early)*

Drop a `.js` / `.mjs` file into `.nou/plugins/` (this project) or `~/.nou/plugins/` (everywhere), then switch it on in <kbd>s</kbd> settings → **Plugins**. A plugin can give the model new tools, add slash commands, and add to the system prompt.

```js
export default {
  name: "word-count",
  tools: [{ readOnly: true, definition: { name: "word_count", /* ... */ }, run: (args) => "42 words" }],
  commands: [{ name: "wc", description: "Count words", run: (args) => "42 words" }],
};
```

Full example: [examples/plugins/word-count.mjs](examples/plugins/word-count.mjs).

> [!WARNING]
> Plugins run code on your machine, so they stay **off** until you enable them.

## 🛠️ Development

```bash
npm install
npm run dev          # run from source
npm run build        # compile to dist/
npm run screenshot   # regenerate docs/screenshot.svg
```

Releasing: bump `version` in `package.json`, merge to `master`, then run **Actions → Publish to npm** (or publish a GitHub release tagged `vX.Y.Z`). The token lives in the `production` environment as `NPM_TOKEN`.

<p align="center"><sub>Made with 🌞 by <a href="https://github.com/JorgeOchoaReyes">Jorge Ochoa-Reyes</a></sub></p>
