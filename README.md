# Nou

An IDE-style AI coding assistant that lives in your terminal: file explorer, code view with live side-by-side diffs, a built-in editor, and a chat with an agent that reads, edits and runs things in your project. Works with local models (Ollama, LM Studio, llama.cpp) and cloud ones (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek).

```
npm install -g nou-cli
cd your-project
nou
```

Needs Node 20.12+ and an interactive terminal (Windows Terminal, PowerShell, macOS/Linux terminals). For local models, install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull qwen3:8b` (the default).

## Using it

| Key | Does |
| --- | --- |
| `Tab` | switch between files, code and chat |
| `Ctrl+P` | fuzzy-find a file |
| `e` | edit the open file (`Ctrl+S` save, `Ctrl+Z` undo, `Esc` close) |
| `v` | diff the open file against git `HEAD` (or Nou's last edit) |
| `c` | in the file tree, show only changed files |
| `f` | follow mode: jump to files Nou is reading/editing |
| `s` or `/settings` | settings: model, preferences, plugins |
| `y` / `n` | accept / reject a proposed edit or command |
| `Esc` | stop Nou, close a diff, back to chat |

Nou sees what you're looking at: the open file and visible lines (or your cursor line and unsaved edits while editing) are attached to each message, so "explain this function" just works. In a git repo it also gets your branch, uncommitted changes and recent commits, plus `git_status` / `git_diff` / `git_log` tools.

Chat commands: `/settings`, `/model [provider:model]`, `/models [provider]`, `/clear`, `/help`.

## Models

Pick one in `/settings`, with `/model anthropic`, `/model ollama:qwen3:8b`, or `NOU_MODEL=provider:model`. API keys come from your environment or a `.env` file in the project; see [.env.example](.env.example).

| Provider | Setup |
| --- | --- |
| Ollama (default) | runs locally, `OLLAMA_HOST` to change |
| LM Studio, llama.cpp | start their local server |
| Any OpenAI-compatible server | `NOU_BASE_URL`, optional `NOU_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI / Gemini / OpenRouter / Groq / DeepSeek | `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `DEEPSEEK_API_KEY` |

## Plugins (early)

Drop a `.js`/`.mjs` file into `.nou/plugins/` (project) or `~/.nou/plugins/` (everywhere), then enable it in `/settings → Plugins`. A plugin can add tools for the model, slash commands, and system prompt text. See [examples/plugins/word-count.mjs](examples/plugins/word-count.mjs). Plugins run code on your machine, so they stay off until you enable them.

## Development

```
npm install
npm run dev        # run from source
npm run build      # compile to dist/
```

Releases: create a GitHub release tagged `vX.Y.Z` and the Publish workflow builds and publishes that version to npm (needs an `NPM_TOKEN` secret in the `production` environment).
