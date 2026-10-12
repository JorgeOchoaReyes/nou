import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Agent, buildSystemPrompt, type ApprovalRequest, type ChangeStatus, type ChatEntry } from "../agent/index.js";
import { harness, problemsIntroduced } from "../agent/harness.js";
import { describe, providers, resolveModel, saveModel, type ModelChoice } from "../providers/index.js";
import type { FileChange } from "../commands/index.js";
import { loadSettings, saveSettings, type Settings as SettingsType } from "../config/index.js";
import { branch as gitBranch, diffAgainstHead, isRepo, status as gitStatus, type GitStatus } from "../git/index.js";
import { BUILTIN_PLUGINS, discoverPlugins, isEnabled, loadPlugin, trustPatch, type PluginEntry } from "../plugins/index.js";
import { DiagnosticsManager, formatDiagnostic, newProblems } from "../diagnostics/index.js";
import { Timeline } from "../history/index.js";
import { lsp } from "../lsp/index.js";
import { onGrammarLoaded, preload } from "../syntax/index.js";
import { checkForUpdate, currentVersion } from "../update/index.js";
import { changedLines } from "./text.js";
import { ProblemsView } from "./ProblemsView.js";
import { useMouse } from "./mouse.js";
import { C } from "./theme.js";
import { FileTree } from "./FileTree.js";
import { CodeView } from "./CodeView.js";
import { Editor, type EditorState } from "./Editor.js";
import { Chat } from "./Chat.js";
import { Header } from "./Header.js";
import { QuickOpen, listAllFiles } from "./QuickOpen.js";
import { Settings } from "./Settings.js";

type Focus = "tree" | "code" | "chat";
const FOCUS_ORDER: Focus[] = ["tree", "code", "chat"];
const NO_LINES = new Set<number>();

type Props = { initialModel: ModelChoice; permContext: string };

const HELP = `Commands:
  /settings            models, preferences and plugins
  /model               show providers and the current model
  /model <provider[:model]>  switch, e.g. /model anthropic  /model ollama:qwen3:8b
  /models [provider]   list models a provider offers
  /clear               start a fresh conversation
  /undo                undo Nou's last change (also: u)
  /rewind              undo everything from Nou's last turn
  /history             recent changes
  /version             which version of Nou this is
Keys:
  Ctrl+P  find a file      Tab  switch pane      Esc  stop / back
  e  edit open file        v    diff (git / Nou)  f   follow mode
  p  problems              u    undo Nou's edit   s   settings
  c  (in files) show only changed files            Ctrl+C twice  quit
In the editor: Ctrl+S save · Ctrl+Z/Y undo/redo · Ctrl+K info · Ctrl+G go to definition`;

function readText(filePath: string): string {
  try {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return "";
  }
}

export function App({ initialModel, permContext }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();

  const [settings, setSettings] = useState<SettingsType>(loadSettings);
  const [view, setView] = useState<"main" | "settings">("main");
  const [quickOpen, setQuickOpen] = useState(false);
  const [focus, setFocus] = useState<Focus>("chat");
  const [follow, setFollow] = useState(settings.followMode);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState(initialModel);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve(ok: boolean): void } | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  // The last change Nou made per file, so we can flag edited lines and re-open the diff.
  const [changes, setChanges] = useState<Map<string, { change: FileChange; status: ChangeStatus; lines: Set<number> }>>(new Map());
  const [diffMode, setDiffMode] = useState<"off" | "git" | "nou">("off");
  const [editing, setEditing] = useState(false);
  const [git, setGit] = useState<GitStatus>(() => gitStatus());
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [viewport, setViewport] = useState<{ top: number; bottom: number } | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  // Unsaved editor text survives switching to a diff and back.
  const draft = useRef<{ path: string; text: string; baseline: string } | null>(null);
  const [codePanel, setCodePanel] = useState<"code" | "problems">("code");
  const [, setDiagVersion] = useState(0);
  const [syntaxVersion, setSyntaxVersion] = useState(0);
  const [focusLine, setFocusLine] = useState<{ line: number; nonce: number } | null>(null);
  const [editorStart, setEditorStart] = useState<{ line: number; nonce: number }>({ line: 1, nonce: 0 });
  const [pendingNote, setPendingNote] = useState<{ short: string; detail: string | null } | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const [update, setUpdate] = useState<string | null>(null);
  const [wheel, setWheel] = useState<{ pane: Focus; dir: number; nonce: number } | null>(null);
  const [treeClick, setTreeClick] = useState<{ row: number; nonce: number } | null>(null);
  // Pane geometry from the last render, so mouse events can be mapped to the pane under the pointer.
  const layout = useRef({ treeWidth: 0, codeWidth: 0, paneHeight: 0 });
  const diagnosticsRef = useRef<DiagnosticsManager | null>(null);
  diagnosticsRef.current ??= new DiagnosticsManager();
  const diagnostics = diagnosticsRef.current;
  const timelineRef = useRef<Timeline | null>(null);
  timelineRef.current ??= new Timeline();
  const timeline = timelineRef.current;

  const followRef = useRef(follow);
  followRef.current = follow;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshGit = useCallback(() => setGit(gitStatus()), []);
  const allFiles = useMemo(() => (quickOpen ? listAllFiles() : []), [quickOpen]);
  const repo = useMemo(() => isRepo(), []);
  const branch = useMemo(() => (repo ? gitBranch() : null), [repo, git]);

  const open = useCallback((filePath: string) => {
    setOpenFile(filePath);
    setContent(readText(filePath));
    setDiffMode("off");
    setEditing(false);
    setCodePanel("code");
    preload(filePath);
    void diagnosticsRef.current!.checkFile(filePath);
  }, []);

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    agentRef.current = new Agent(initialModel, buildSystemPrompt(permContext), {
      onEntry: (entry) => setEntries((prev) => [...prev, entry]),
      onStream: setStreaming,
      onBusy: setBusy,
      onRead: (filePath) => {
        if (!followRef.current) return;
        open(filePath);
        setReveal(filePath);
      },
      onChange: (change, status, turn) => {
        if (status === "applied") {
          timelineRef.current!.record({ path: change.path, before: change.isNew ? null : change.before, after: change.after, source: "nou", turn });
        }
        const lines = status === "applied" ? changedLines(change.before, change.after) : NO_LINES;
        setChanges((prev) => new Map(prev).set(change.path, { change, status, lines }));
        // Diffs awaiting approval are always shown, follow mode or not.
        if (status === "pending" || followRef.current) {
          setOpenFile(change.path);
          setContent(status === "applied" ? change.after : readText(change.path));
          setDiffMode("off");
          setReveal(change.path);
        }
        if (status === "applied") {
          setTreeVersion((v) => v + 1);
          setGit(gitStatus());
          if (draft.current?.path === change.path) {
            setEntries((prev) => [...prev, { kind: "info", text: `Heads up: you have unsaved edits in ${change.path}; saving them will overwrite Nou's change.` }]);
          }
        }
      },
      approve: (request) => {
        const s = settingsRef.current;
        if ((request.kind === "change" && s.autoApproveEdits) || (request.kind !== "change" && s.autoApproveCommands)) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => setApproval({ request, resolve }));
      },
      checkChange: (change) => problemsIntroduced(diagnosticsRef.current!, change),
    });
  }

  useEffect(() => diagnostics.subscribe(() => setDiagVersion((v) => v + 1)), []);
  useEffect(() => onGrammarLoaded(() => setSyntaxVersion((v) => v + 1)), []);
  useEffect(() => {
    void checkForUpdate().then(setUpdate);
  }, []);

  // Discover plugins once and load the enabled ones.
  useEffect(() => {
    void (async () => {
      const found = discoverPlugins();
      const saved = loadSettings();
      setPlugins(await Promise.all(found.map((p) => (isEnabled(p, saved) ? loadPlugin(p) : p))));
    })();
  }, []);

  const allPlugins = useMemo(() => [...BUILTIN_PLUGINS, ...plugins], [plugins]);
  const activePlugins = useMemo(() => allPlugins.filter((p) => isEnabled(p, settings) && p.plugin), [allPlugins, settings.plugins, settings.trustedPlugins]);

  // Checkers come from enabled plugins (built-in ones included).
  const firstCheck = useRef(true);
  useEffect(() => {
    diagnostics.setProviders(activePlugins.flatMap((p) => p.plugin!.diagnostics ?? []));
    if (firstCheck.current) {
      firstCheck.current = false;
      setTimeout(() => void diagnostics.checkProject(), 1500);
    }
  }, [activePlugins]);

  // Keep the agent's system prompt and tools in sync with settings and plugins.
  useEffect(() => {
    const { extras, extraTools } = harness({ diagnostics, plugins: activePlugins.map((p) => p.plugin!), git: settings.gitContext && repo });
    agentRef.current!.configure({ system: buildSystemPrompt(permContext, extras), extraTools, effort: settings.effort });
  }, [settings.gitContext, settings.effort, activePlugins]);

  // Pick up changes made outside Nou (other editors, git commands).
  useEffect(() => {
    if (!repo) return;
    const timer = setInterval(() => {
      if (!busy) setGit(gitStatus());
    }, 4000);
    return () => clearInterval(timer);
  }, [repo, busy]);

  useEffect(() => {
    if (busy) return;
    refreshGit();
    if (openFile && diffMode === "off" && !editing) setContent(readText(openFile));
  }, [busy]);

  const updateSettings = (patch: Partial<SettingsType>) => setSettings(saveSettings(patch));

  const switchModel = (next: ModelChoice) => {
    const problem = next.provider.unavailable();
    if (problem) {
      setEntries((prev) => [...prev, { kind: "error", text: `${next.provider.label} isn't set up: ${problem}` }]);
      return false;
    }
    agentRef.current!.setModel(next);
    setChoice(next);
    saveModel(next);
    setSettings(loadSettings());
    setEntries((prev) => [...prev, { kind: "info", text: `Now using ${describe(next)}. The conversation carries over.` }]);
    return true;
  };

  const togglePlugin = async (id: string, enabled: boolean) => {
    const entry = allPlugins.find((p) => p.id === id);
    if (!entry) return;
    updateSettings(trustPatch(entry, enabled, settings));
    if (!enabled) return;
    if (!entry.plugin) {
      const loaded = await loadPlugin(entry);
      setPlugins((prev) => prev.map((p) => (p.id === id ? loaded : p)));
    }
  };

  const answer = (ok: boolean) => {
    approval?.resolve(ok);
    setApproval(null);
  };

  const record = openFile ? changes.get(openFile) : undefined;
  const pendingChange = approval?.request.kind === "change" ? approval.request.change : null;
  const gitChange = useMemo(
    () => (diffMode === "git" && openFile ? diffAgainstHead(openFile, content) : null),
    [diffMode, openFile, content],
  );
  const diff = pendingChange ?? (diffMode === "git" ? gitChange : diffMode === "nou" && record ? record.change : null);
  const showEditor = editing && !!openFile && !pendingChange;

  // Check Nou's proposed edit before you approve it: does it add problems?
  useEffect(() => {
    setPendingNote(null);
    if (!pendingChange) return;
    let cancelled = false;
    void (async () => {
      const before = await diagnostics.checkText(pendingChange.path, pendingChange.before);
      const after = await diagnostics.checkText(pendingChange.path, pendingChange.after);
      if (cancelled) return;
      const added = newProblems(before, after);
      setPendingNote(added.length
        ? { short: `⚠ +${added.length} problem${added.length === 1 ? "" : "s"}`, detail: added.slice(0, 3).map((d) => formatDiagnostic(d)).join("\n") }
        : { short: "✓ no new problems", detail: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingChange]);

  // Live problems while you type (debounced).
  useEffect(() => {
    if (!showEditor || !openFile || !editorState) return;
    const timer = setTimeout(() => void diagnostics.checkFile(openFile, editorState.lines.join("\n")), 700);
    return () => clearTimeout(timer);
  }, [editorState?.lines]);

  /** Quit, saving the editor's unsaved text first if auto-save is on. */
  const quit = () => {
    if (draft.current && settings.autoSave !== "off") saveFromEditor(draft.current.text, draft.current.path);
    exit();
  };

  /** Quitting always takes two presses (Ctrl+C or q) within 2 seconds, so a stray key never loses work. */
  const requestQuit = () => {
    if (exitArmed) return quit();
    setExitArmed(true);
    setTimeout(() => setExitArmed(false), 2000);
  };

  // Mouse: the wheel scrolls whatever pane is under the pointer; a click focuses that pane
  // (and in the file tree, opens the clicked file).
  useMouse((event) => {
    if (view !== "main" || quickOpen) return;
    const { treeWidth, codeWidth, paneHeight } = layout.current;
    if (event.y < 1 || event.y > paneHeight) return; // header or status bar
    const pane: Focus = event.x < treeWidth ? "tree" : event.x < treeWidth + codeWidth ? "code" : "chat";
    if (event.kind === "wheel") {
      setWheel((w) => ({ pane, dir: event.dir, nonce: (w?.nonce ?? 0) + 1 }));
      return;
    }
    if (approval) return;
    setFocus(pane);
    // Rows start under the pane's top border (y=1) and title (y=2).
    if (pane === "tree" && event.y >= 3) setTreeClick((c) => ({ row: event.y - 3, nonce: (c?.nonce ?? 0) + 1 }));
  }, settings.mouse);

  // Ctrl+C: stop Nou if it's working; otherwise press twice to quit.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (busy || approval) {
      agentRef.current?.cancel();
      approval?.resolve(false);
      setApproval(null);
      return;
    }
    requestQuit();
  });

  const info = (text: string, kind: ChatEntry["kind"] = "info") => setEntries((prev) => [...prev, { kind, text }]);

  /** After a file changes outside the normal flow (undo), refresh everything that shows it. */
  const reload = (file: string) => {
    if (file === openFile) setContent(readText(file));
    setTreeVersion((v) => v + 1);
    refreshGit();
    void diagnostics.checkFile(file);
  };

  const undoCheckpoints = (list: ReturnType<typeof timeline.lastTurn>) => {
    const done: string[] = [];
    for (const cp of list) {
      const result = timeline.undo(cp);
      if (result.ok) {
        done.push(cp.path);
        info(`↶ Undid Nou's change to ${cp.path}${result.merged ? " (kept your later edits)" : ""}`);
        reload(cp.path);
      } else {
        info(`Couldn't undo ${cp.path}: ${result.reason}. Press v on the file to see the diff.`, "error");
      }
    }
    if (done.length) agentRef.current!.note(`The user undid your changes to ${done.join(", ")}; those files are back to how they were before your edits.`);
  };

  const undoLast = () => {
    const last = timeline.lastNouChange();
    if (!last) return info("Nothing of Nou's to undo.");
    undoCheckpoints([last]);
  };

  const rewind = () => {
    const turn = timeline.lastTurn();
    if (!turn.length) return info("Nothing of Nou's to rewind.");
    undoCheckpoints(turn);
  };

  const showHistory = () => {
    const items = timeline.all.slice(-15).reverse();
    if (!items.length) return info("No changes recorded yet.");
    info(`Recent changes (newest first):\n${items.map((c) => {
      const time = new Date(c.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `  ${time}  ${c.source === "nou" ? "Nou" : "you"}  ${c.before === null ? "created " : ""}${c.path}${c.undone ? "  (undone)" : ""}`;
    }).join("\n")}\nUndo with /undo (last) or /rewind (whole last turn).`);
  };

  /**
   * Before editing another file: an unsaved draft of a different file is saved (auto-save on) or kept and
   * the switch refused (auto-save off). Never silently dropped. Returns whether it's OK to continue.
   */
  const settleDraft = (target: string): boolean => {
    if (!draft.current || draft.current.path === target) return true;
    if (settings.autoSave !== "off") {
      saveFromEditor(draft.current.text, draft.current.path);
      return true;
    }
    info(`You have unsaved edits in ${draft.current.path}. Open it and save (Ctrl+S) first, or turn on auto-save in settings.`, "error");
    return false;
  };

  /** Opens a file at a line, in the editor if `edit` (used by the Problems list and go-to-definition). */
  const openAt = (file: string, line: number, edit = false) => {
    if (!settleDraft(file)) return;
    if (file !== openFile) open(file);
    setReveal(file);
    setCodePanel("code");
    if (edit) {
      setEditorStart((s) => ({ line, nonce: s.nonce + 1 }));
      setEditing(true);
      setFocus("code");
    } else {
      setFocusLine((f) => ({ line, nonce: (f?.nonce ?? 0) + 1 }));
    }
  };

  const startEditing = () => {
    if (!openFile || !settleDraft(openFile)) return;
    setDiffMode("off");
    setCodePanel("code");
    setEditorStart((s) => ({ line: viewport?.top ?? 1, nonce: s.nonce + 1 }));
    setEditing(true);
    setFocus("code");
  };

  const cycleDiff = () => {
    if (!openFile) return;
    const order: ("off" | "git" | "nou")[] = ["off"];
    if (git.has(openFile)) order.push("git");
    if (record?.status === "applied") order.push("nou");
    if (order.length === 1) {
      setEntries((prev) => [...prev, { kind: "info", text: `${openFile} has no changes vs git HEAD.` }]);
      return;
    }
    setEditing(false);
    setDiffMode((m) => order[(order.indexOf(m) + 1) % order.length]!);
  };

  useInput((input, key) => {
    if (approval) {
      if (input === "y" || input === "Y") answer(true);
      else if (input === "n" || input === "N") answer(false);
      else if (key.escape) {
        agentRef.current?.cancel();
        answer(false);
      }
      return;
    }
    if (key.ctrl && input === "p") {
      setQuickOpen(true);
      return;
    }
    if (showEditor && focus === "code") return; // the editor owns the keyboard
    if (key.tab) {
      const step = key.shift ? -1 : 1;
      setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + step + FOCUS_ORDER.length) % FOCUS_ORDER.length]!);
      return;
    }
    if (key.escape) {
      if (busy) agentRef.current?.cancel();
      else if (diffMode !== "off") setDiffMode("off");
      else setFocus("chat");
      return;
    }
    if (focus === "chat") return; // letters belong to the text box
    if (input === "f") setFollow((f) => !f);
    else if (input === "p") {
      setCodePanel((p) => (p === "problems" ? "code" : "problems"));
      setEditing(false);
      setFocus("code");
    } else if (input === "u") undoLast();
    else if (input === "v") cycleDiff();
    else if (input === "e") startEditing();
    else if (input === "s" || input === ",") setView("settings");
    else if (input === "r") {
      refreshGit();
      setTreeVersion((v) => v + 1);
    } else if (input === "q") requestQuit();
  }, { isActive: view === "main" && !quickOpen && !(codePanel === "problems" && focus === "code") });

  /** What the user is looking at, attached to each message so "this file" / "here" make sense. */
  const editorContext = (): string | null => {
    if (!openFile) return null;
    const unsaved = showEditor && editorState?.dirty;
    const lines = showEditor && editorState ? editorState.lines : content.replace(/\r\n/g, "\n").split("\n");
    let from: number;
    let to: number;
    let where: string;
    if (showEditor && editorState) {
      from = Math.max(1, editorState.line - 15);
      to = Math.min(lines.length, editorState.line + 15);
      where = `cursor on line ${editorState.line}`;
    } else {
      from = viewport?.top ?? 1;
      to = Math.min(lines.length, viewport?.bottom ?? 40, from + 80);
      where = `lines ${from}-${to} visible`;
    }
    const snippet = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join("\n");
    return `<editor_context>
The user has ${openFile} open in the editor (${where}${unsaved ? "; they have unsaved edits, shown below" : ""}${git.get(openFile) ? `; git status ${git.get(openFile)}` : ""}).
${snippet}
</editor_context>`;
  };

  const contextChip = openFile
    ? `${openFile}${showEditor && editorState ? `:${editorState.line}${editorState.dirty ? " ✎ unsaved" : ""}` : viewport ? `:${viewport.top}-${viewport.bottom}` : ""}`
    : null;

  const runCommand = async (input: string) => {
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (command) {
    case "undo":
      return undoLast();
    case "rewind":
      return rewind();
    case "history":
      return showHistory();
    case "problems":
      setCodePanel("problems");
      setFocus("code");
      return;
    case "settings":
      setView("settings");
      return;
    case "model": {
      if (!arg) {
        const list = providers.map((p) => {
          const problem = p.unavailable();
          return `${p.id === choice.provider.id ? "▸" : " "} ${p.id.padEnd(10)} ${p.local ? "local " : "cloud "} ${problem ? `(${problem})` : `default ${p.defaultModel}`}`;
        });
        info(`Current: ${describe(choice)}\n${list.join("\n")}\nSwitch with /model <provider[:model]> or open /settings`);
        return;
      }
      switchModel(resolveModel(arg));
      return;
    }
    case "models": {
      const provider = arg ? providers.find((p) => p.id === arg) : choice.provider;
      if (!provider) return info(`Unknown provider "${arg}". Try /model to see them.`, "error");
      setBusy(`Listing ${provider.id} models...`);
      try {
        const models = await provider.listModels();
        info(models.length ? `${provider.id} models:\n${models.slice(0, 60).map((m) => `  ${provider.id}:${m}`).join("\n")}` : `${provider.id} has no models.`);
      } catch (error: any) {
        info(`Couldn't list ${provider.id} models: ${error.message}`, "error");
      } finally {
        setBusy(null);
      }
      return;
    }
    case "clear":
      agentRef.current!.clear();
      setEntries([]);
      return;
    case "version":
      return info(`nou v${currentVersion()}${update ? ` · v${update} is available, run \`nou update\`` : " · up to date"}`);
    case "help":
      return info(HELP);
    default: {
      for (const { plugin } of activePlugins) {
        const found = plugin!.commands?.find((c) => c.name === command);
        if (!found) continue;
        try {
          const out = await found.run(arg, { cwd: process.cwd() });
          if (out) info(out);
        } catch (error: any) {
          info(`/${command}: ${error.message}`, "error");
        }
        return;
      }
      return info(`Unknown command /${command}. Type /help.`, "error");
    }
    }
  };

  const send = (text: string) => {
    if (text.startsWith("/")) {
      void runCommand(text);
      return;
    }
    setEntries((prev) => [...prev, { kind: "user", text }]);
    void agentRef.current!.send(text, editorContext() ?? undefined);
  };

  function saveFromEditor(text: string, file = openFile) {
    if (!file) return;
    try {
      const full = path.resolve(process.cwd(), file);
      const before = readText(file);
      writeFileSync(full, text, "utf-8");
      timeline.record({ path: file, before, after: text, source: "you", turn: agentRef.current!.turnId });
      if (file === openFile) setContent(text);
      if (draft.current?.path === file) draft.current = null;
      setTreeVersion((v) => v + 1);
      refreshGit();
      void diagnostics.checkFile(file);
      diagnostics.scheduleProject();
    } catch (error: any) {
      setEntries((prev) => [...prev, { kind: "error", text: `Couldn't save ${file}: ${error.message}` }]);
    }
  }

  if (view === "settings") {
    return (
      <Settings
        width={columns}
        height={rows}
        settings={settings}
        choice={choice}
        plugins={allPlugins}
        onModel={(next) => switchModel(next)}
        onChange={updateSettings}
        onTogglePlugin={(id, enabled) => void togglePlugin(id, enabled)}
        onRescanPlugins={() => {
          const found = discoverPlugins();
          setPlugins((prev) => found.map((f) => prev.find((p) => p.id === f.id && p.plugin) ?? f));
        }}
        onClose={() => setView("main")}
      />
    );
  }

  const height = Math.max(10, rows - 2);
  const treeWidth = Math.max(24, Math.floor(columns * 0.2));
  const chatWidth = Math.max(34, Math.floor(columns * 0.3));
  const codeWidth = Math.max(20, columns - treeWidth - chatWidth);
  layout.current = { treeWidth, codeWidth, paneHeight: height };
  const wheelFor = (pane: Focus) => (wheel?.pane === pane ? wheel : null);
  const edited = new Set([...changes].filter(([, c]) => c.status === "applied").map(([p]) => p));
  const fileProblems = openFile ? diagnostics.get(openFile) : [];
  const totals = diagnostics.counts();
  const checking = diagnostics.busy;
  const lspEnabled = activePlugins.some((p) => p.id === "lsp");

  const mode = approval
    ? { label: "APPROVE", color: C.yellow }
    : showEditor ? { label: "EDIT", color: C.green }
      : diff ? { label: "DIFF", color: C.accent2 }
        : busy ? { label: "WORKING", color: C.accent2 }
          : { label: focus.toUpperCase(), color: C.accent };

  const hints = approval
    ? "y accept · n reject · Esc stop"
    : showEditor && focus === "code"
      ? `Ctrl+S save${settings.autoSave === "off" ? "" : " (auto-save on)"} · Ctrl+Z/Y undo/redo · Ctrl+K info · Ctrl+G definition · Esc close`
      : focus === "chat"
        ? busy ? "Esc stop · Shift+↑↓ scroll chat · Tab switch pane" : "Enter send · Shift+↑↓ / PgUp scroll · / commands · Ctrl+P find file · Tab switch pane"
        : focus === "tree"
          ? "↑↓ move · Enter open · c changes · e edit · p problems · u undo · Ctrl+P find · s settings"
          : diff ? "n/N next/prev change · v cycle diff · Esc close diff" : "↑↓ scroll · e edit · v diff · p problems · u undo · s settings";

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header width={columns} branch={branch} changes={git.size} model={describe(choice)} local={choice.provider.local} busy={busy} update={update} />
      <Box flexDirection="row" height={height}>
        <FileTree
          width={treeWidth}
          height={height}
          focused={focus === "tree" && !approval}
          openFile={openFile}
          reveal={reveal}
          version={treeVersion}
          changed={edited}
          git={git}
          problemCounts={diagnostics.fileCounts()}
          wheel={wheelFor("tree")}
          click={treeClick}
          onOpen={(filePath) => {
            open(filePath);
            setFocus("code");
          }}
          onHover={() => {}}
        />
        {codePanel === "problems" && !pendingChange ? (
          <ProblemsView
            width={codeWidth}
            height={height}
            focused={focus === "code" && !approval}
            problems={diagnostics.all()}
            checking={checking}
            wheel={wheelFor("code")}
            onJump={(file, line) => openAt(file, line)}
            onClose={() => setCodePanel("code")}
          />
        ) : showEditor ? (
          <Editor
            key={`${openFile}:${editorStart.nonce}`}
            width={codeWidth}
            height={height}
            focused={focus === "code"}
            filePath={openFile}
            initial={draft.current?.path === openFile ? draft.current.text : content}
            baseline={draft.current?.path === openFile ? draft.current.baseline : content}
            startLine={editorStart.line}
            problems={fileProblems}
            autoSave={settings.autoSave}
            syntaxVersion={syntaxVersion}
            wheel={wheelFor("code")}
            onHover={(text, line, col) => (lspEnabled ? lsp.hover(openFile, text, line, col) : Promise.resolve(null))}
            onDefinition={(text, line, col) => {
              if (!lspEnabled) return info("Go to definition needs a language server (see /settings → Plugins).", "error");
              void lsp.definition(openFile, text, line, col).then((target) => {
                if (!target) return info("No definition found here.");
                // Keep unsaved text when jumping within the same file.
                if (target.file === openFile && draft.current) draft.current = { ...draft.current, text };
                openAt(target.file, target.line, true);
              });
            }}
            onSave={(text) => saveFromEditor(text)}
            onExit={() => {
              draft.current = null;
              setEditing(false);
            }}
            onState={(state) => {
              setEditorState(state);
              draft.current = state.dirty
                ? { path: openFile, text: state.lines.join("\n"), baseline: draft.current?.path === openFile ? draft.current.baseline : content }
                : null;
            }}
          />
        ) : (
          <CodeView
            width={codeWidth}
            height={height}
            focused={focus === "code" && !approval}
            filePath={openFile}
            content={content}
            diff={diff}
            diffLabel={diffMode === "git" ? "vs HEAD" : "Nou's edit"}
            pending={!!pendingChange}
            marked={record?.lines ?? NO_LINES}
            problems={fileProblems}
            focusLine={focusLine}
            syntaxVersion={syntaxVersion}
            diffNote={pendingChange ? pendingNote?.short ?? (checking.length ? "checking…" : null) : null}
            wheel={wheelFor("code")}
            onViewport={(top, bottom) => setViewport((v) => (v?.top === top && v.bottom === bottom ? v : { top, bottom }))}
          />
        )}
        <Chat
          width={chatWidth}
          height={height}
          focused={focus === "chat"}
          entries={entries}
          streaming={streaming}
          busy={busy}
          approval={approval?.request ?? null}
          approvalNote={pendingChange ? pendingNote?.detail ?? null : null}
          contextChip={contextChip}
          wheel={wheelFor("chat")}
          onSubmit={send}
        />
      </Box>
      <Box>
        <Text wrap="truncate-end">
          <Text backgroundColor={mode.color} color="black" bold>{` ${mode.label} `}</Text>
          <Text backgroundColor={C.panel} color={follow ? C.green : C.dim}>{follow ? " ◉ follow " : " ○ follow "}</Text>
          <Text backgroundColor={C.panel} color={totals.errors ? C.red : C.dim}>{` ✖ ${totals.errors}`}</Text>
          <Text backgroundColor={C.panel} color={totals.warnings ? C.yellow : C.dim}>{` ▲ ${totals.warnings} `}</Text>
          {checking.length > 0 && <Text color={C.accent2}> ⟳ {checking.join(", ")}</Text>}
          {exitArmed
            ? <Text color={C.yellow} bold>{"  "}Press again to quit{draft.current && settings.autoSave === "off" ? ` (unsaved changes in ${draft.current.path} will be lost)` : ""}</Text>
            : <Text color={C.dim}>{"  "}{hints}</Text>}
        </Text>
      </Box>
      {quickOpen && (
        <QuickOpen
          width={columns}
          top={3}
          files={allFiles}
          onPick={(file) => {
            setQuickOpen(false);
            open(file);
            setReveal(file);
            setFocus("code");
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}
    </Box>
  );
}
