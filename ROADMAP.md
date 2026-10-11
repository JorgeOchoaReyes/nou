# Roadmap

What's next for Nou, roughly in priority order. Open an issue or PR to discuss any of these.

## 🔄 Keep everyone up to date automatically

**Goal:** people running `nou` should always be on the latest version without having to think about it.

What already works (since 0.2.0):
- Each time `nou` starts, it asks npm for the latest version (at most once a day, cached in `~/.nou/update.json`, never waiting more than 1.5 s) and offers to update and restart.
- `nou update` and `nou --version`; the header shows the version and a "⬆ available" badge; `/version` in chat.

Still to do:
- [ ] **Check every launch, not once a day.** Keep it fast by checking in the background and showing the result in the header instead of blocking startup; still prompt on the next launch.
- [ ] **Check during long sessions** (e.g. every few hours) so people who keep Nou open for days hear about updates.
- [ ] **Auto-update setting:** `ask` (default) / `always` (update silently in the background, use on next launch) / `never`.
- [ ] **Show what's new:** after updating, show the release notes (from the GitHub Release the publish workflow creates).
- [ ] **Handle permission errors** on macOS/Linux global installs: detect `EACCES` and explain `sudo` or switching to a Node version manager, instead of a generic failure.
- [ ] **Version 0.1.0 users** can't be reached by this (0.1.0 had no update check). Mention `npm i -g nou-cli@latest` in the README and release notes.

## 🖱️ Mouse and terminals
- [ ] Confirm mouse-wheel scrolling on Windows (Windows Terminal, PowerShell, cmd). It's tested on Linux/macOS-style input; Windows depends on how Node passes console mouse input through.
- [ ] Click inside the code to place the cursor in the editor; click problems in the Problems list.

## 🧠 Code intelligence
- [ ] TypeScript 7: `typescript-language-server` doesn't support it yet. Support TypeScript 7's own language server when it's available, and update `typescript` (Dependabot is told to skip TS majors until `typescript-eslint` supports 7).
- [ ] More language-server features: find references, rename, completions in the editor.
- [ ] Let users add their own language servers in settings (command + file types).

## 🧩 Plugins
- [ ] Grow the plugin API (UI panels, hooks before/after edits) and document it properly.
- [ ] A way to share and install plugins (e.g. `nou plugin add <npm package>`), still requiring approval before they run.

## 🔐 Releases and security
- [ ] Switch npm publishing to **trusted publishing** (GitHub OIDC) and delete the `NPM_TOKEN` secret.
- [ ] Require CI to pass before merging to `master` (branch protection).
- [ ] Update `web-tree-sitter` and `tree-sitter-wasms` together once compatible grammar builds exist (pinned on purpose today).
