import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { buildSystemPrompt, type AgentHooks, type ApprovalRequest, type ChangeStatus, type ChatEntry } from "../agent/index.js";
import { ENGINES, createEngine, engineInfo, installEngine, isEngineId, isInstalled, type Engine, type EngineId, type EngineOptions } from "../engines/index.js";
import { harness, problemsIntroduced } from "../agent/harness.js";
import { describe, providers, resolveModel, saveModel, type ModelChoice } from "../providers/index.js";
import { sameModel } from "../providers/ollama.js";
import type { FileChange } from "../commands/index.js";
import { loadSettings, saveSettings, type Settings as SettingsType } from "../config/index.js";
import { branch as gitBranch, diffAgainstHead, isRepo, sameStatus, status as gitStatus, statusAsync as gitStatusAsync, type GitStatus } from "../git/index.js";
import { BUILTIN_PLUGINS, addStarter, discoverPlugins, isEnabled, loadPlugin, scaffoldPlugin, starterPlugins, trustPatch, trustState, type PluginEntry } from "../plugins/index.js";
import { DiagnosticsManager, formatDiagnostic, newProblems } from "../diagnostics/index.js";
import { Timeline, type SessionSummary } from "../history/index.js";
import { lsp } from "../lsp/index.js";
import { onGrammarLoaded, preload } from "../syntax/index.js";
import { checkForUpdate, currentVersion } from "../update/index.js";
import { changedLines, lineCounts } from "./text.js";
import { ProblemsView } from "./ProblemsView.js";
import { useMouse } from "./mouse.js";
import { C } from "./theme.js";
import { FileTree } from "./FileTree.js";
import { CodeView } from "./CodeView.js";
import { Editor, type EditorState } from "./Editor.js";
import { Chat } from "./Chat.js";
import { copyToClipboard } from "./clipboard.js";
import { Header } from "./Header.js";
import { QuickOpen, listAllFiles } from "./QuickOpen.js";
import { Settings } from "./Settings.js";

type Focus = "tree" | "code" | "chat";
type DiffMode = "off" | "git" | "nou" | "session";
const FOCUS_ORDER: Focus[] = ["tree", "code", "chat"];
const MIN_TREE = 14;
const MIN_CODE = 20;
const MIN_CHAT = 24;
const NO_LINES = new Set<number>();

type Props = { initialModel: ModelChoice; permContext: string };

const HELP = `Commands:
  /settings            models, preferences and plugins
  /model               show providers and the current model
  /model <provider[:model]>  switch, e.g. /model anthropic  /model ollama:qwen3:8b
  /models [provider]   list models a provider offers
  /pull <model>        download an Ollama model
  /engine [name]       which agent answers: nou, claude-code, codex or pi
  /auto [ask|auto-edit|auto]  how much Nou does without asking (also: Shift+Tab)
  /copy [code|file]    copy the last reply, its last code block, or the open file
  /plugins             your plugins and the starter ones you can add
  /plugins add <name>  add a starter plugin (copied to ~/.nou/plugins to edit)
  /plugins new <name>  start your own plugin in .nou/plugins/
  /clear               start a fresh conversation
  /compact             summarize the conversation so far, to free up context
  /undo                undo Nou's last change (also: u)
  /rewind              undo everything from Nou's last turn
  /history             recent changes
  /diff [file]         everything changed this session ([ ] step through files)
  /sessions            earlier sessions; /diff <n> shows one of them
  /version             which version of Nou this is
Keys:
  Ctrl+P  find a file      Tab  switch pane      Esc  stop / back
  Shift+Tab  ask / auto-edit / auto                < > resize pane  = reset
  m  mouse on/off (off: select text to copy; Shift+drag also works in most terminals)
  e  edit open file        v    diff (git / Nou / session)  f   follow mode
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
  // Streamed text arrives a token at a time; redrawing the whole screen for each one is wasted work.
  const streamed = useRef({ text: "", timer: null as ReturnType<typeof setTimeout> | null });
  const showStream = (text: string) => {
    const s = streamed.current;
    s.text = text;
    if (!text) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      setStreaming("");
    } else if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = null;
        setStreaming(s.text);
      }, 33);
    }
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState(initialModel);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve(ok: boolean): void } | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  // The last change Nou made per file, so we can flag edited lines and re-open the diff.
  const [changes, setChanges] = useState<Map<string, { change: FileChange; status: ChangeStatus; lines: Set<number> }>>(new Map());
  const [diffMode, setDiffMode] = useState<DiffMode>("off");
  // Which session the "session" diff shows (null: this one), and a counter that bumps when history changes.
  const [sessionView, setSessionView] = useState<{ id: string; label: string } | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [git, setGit] = useState<GitStatus>(() => gitStatus());
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [starters, setStarters] = useState<PluginEntry[]>([]);
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
  /** Pane widths while a border is dragged (saved on release); the saved ones otherwise. */
  const [paneWidths, setPaneWidths] = useState(settings.paneWidths);
  const paneWidthsRef = useRef(paneWidths);
  paneWidthsRef.current = paneWidths;
  const dragging = useRef<"tree" | "chat" | null>(null);
  const pullAbort = useRef<AbortController | null>(null);
  const diagnosticsRef = useRef<DiagnosticsManager | null>(null);
  diagnosticsRef.current ??= new DiagnosticsManager();
  const diagnostics = diagnosticsRef.current;
  const timelineRef = useRef<Timeline | null>(null);
  timelineRef.current ??= new Timeline(() => setHistoryVersion((v) => v + 1));
  const timeline = timelineRef.current;

  const followRef = useRef(follow);
  /** Whether the editor is open, for the agent hooks (which outlive renders). */
  const draftActiveRef = useRef(false);
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

  const agentRef = useRef<Engine | null>(null);
  const hooksRef = useRef<AgentHooks | null>(null);
  /** What the engine was last configured with, to configure a new one the same way. */
  const engineConfig = useRef<EngineOptions>({});
  if (!hooksRef.current) {
    hooksRef.current = {
      onEntry: (entry) => setEntries((prev) => [...prev, entry]),
      onStream: showStream,
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
        // Diffs awaiting approval are shown unless you're in the middle of editing a file (the chat says what's waiting).
        if ((status === "pending" && !draftActiveRef.current) || followRef.current) {
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
    };
  }
  if (!agentRef.current) {
    const saved = loadSettings().engine;
    agentRef.current = createEngine(isEngineId(saved) ? saved : "nou", initialModel, buildSystemPrompt(permContext), hooksRef.current);
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
      setStarters(await Promise.all(starterPlugins().map(loadPlugin)));
    })();
  }, []);

  // Starter plugins are listed until you add them (or have your own plugin with the same name).
  const allPlugins = useMemo(
    () => [...BUILTIN_PLUGINS, ...plugins, ...starters.filter((s) => !plugins.some((p) => p.id === s.id))],
    [plugins, starters],
  );
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
    engineConfig.current = { system: buildSystemPrompt(permContext, extras), extras: [...extras, permContext].filter(Boolean), extraTools, effort: settings.effort };
    agentRef.current!.configure(engineConfig.current);
  }, [settings.gitContext, settings.effort, activePlugins]);

  // Pick up changes made outside Nou (other editors, git commands).
  const polling = useRef(false);
  useEffect(() => {
    if (!repo) return;
    const timer = setInterval(() => {
      if (busy || polling.current) return;
      polling.current = true;
      void gitStatusAsync().then((next) => {
        polling.current = false;
        // Only redraw when something changed.
        setGit((prev) => (sameStatus(prev, next) ? prev : next));
      });
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
    const engine = agentRef.current!;
    const carries = engine.id === "nou" || engine.id === "claude-code";
    setEntries((prev) => [...prev, { kind: "info", text: `Now using ${engine.id === "nou" ? describe(next) : `${engineInfo(engine.id).label} with ${engineInfo(engine.id).model(next)}`}. ${carries ? "The conversation carries over." : "This starts a new conversation."}` }]);
    return true;
  };

  /** Switches the agent engine, installing it first if needed (Esc stops the install). Starts a new conversation. */
  const switchEngine = async (id: EngineId) => {
    if (busy) return info("Wait for the current reply to finish (or press Esc) before switching engines.", "error");
    const target = engineInfo(id);
    if (agentRef.current!.id === id) return info(`Already using ${target.label}.`);
    if (!isInstalled(target)) {
      const controller = new AbortController();
      pullAbort.current = controller;
      info(`${target.label} isn't installed yet, so Nou is installing it now: npm install ${target.package} into ~/.nou/engines. This happens once and can take a minute. Esc to stop.`);
      setBusy(`Installing the ${target.label} engine (npm)...`);
      try {
        await installEngine(target, (line) => setBusy(`Installing the ${target.label} engine (npm): ${line.slice(0, 70)}`), controller.signal);
      } catch (error: any) {
        return info(controller.signal.aborted ? `Stopped installing ${target.label}. Nothing changed; you're still on ${engineInfo(agentRef.current!.id).label}.` : `Couldn't install ${target.label}: ${error.message}`, "error");
      } finally {
        pullAbort.current = null;
        setBusy(null);
      }
      info(`Installed ${target.label} (${target.package}).`);
    }
    agentRef.current!.dispose?.();
    const engine = createEngine(id, choice, engineConfig.current.system ?? buildSystemPrompt(permContext), hooksRef.current!);
    engine.configure(engineConfig.current);
    agentRef.current = engine;
    updateSettings({ engine: id });
    info(`Now using the ${target.label} engine (model: ${target.model(choice)}). This starts a new conversation.${target.approvals === "after" ? " It edits without asking first; review its changes in the diff view and press u to undo." : ""}`);
  };

  /** Downloads an Ollama model, showing progress in the status line. Esc stops it. */
  const pullModel = async (model: string): Promise<boolean> => {
    const ollama = providers.find((p) => p.id === "ollama")!;
    const controller = new AbortController();
    pullAbort.current = controller;
    setBusy(`Downloading ${model}...`);
    try {
      await ollama.pull!(model, (status, percent) => setBusy(`Downloading ${model}: ${percent === null ? status : `${percent}%`}`), controller.signal);
      info(`Downloaded ${model}.`);
      return true;
    } catch (error: any) {
      info(controller.signal.aborted ? `Stopped downloading ${model}.` : `Couldn't download ${model}: ${error.message}`, "error");
      return false;
    } finally {
      pullAbort.current = null;
      setBusy(null);
    }
  };

  /** Switches model, downloading it first if it's an Ollama model that isn't installed yet. */
  const chooseModel = async (next: ModelChoice) => {
    if (next.provider.pull) {
      const installed = await next.provider.listModels().catch(() => null);
      if (installed && !installed.some((m) => sameModel(m, next.model))) {
        info(`${next.model} isn't downloaded yet; downloading it now (Esc to stop).`);
        if (!(await pullModel(next.model))) return;
      }
    }
    switchModel(next);
  };

  /** Copies a starter plugin into ~/.nou/plugins/, switches it on and loads it. */
  const addStarterPlugin = async (starter: PluginEntry): Promise<PluginEntry> => {
    const added = addStarter(starter);
    updateSettings(trustPatch(added, true, settings));
    const loaded = await loadPlugin(added);
    setPlugins((prev) => [...prev.filter((p) => p.id !== added.id), loaded]);
    return loaded;
  };

  const rescanPlugins = () => {
    const found = discoverPlugins();
    setPlugins((prev) => found.map((f) => prev.find((p) => p.id === f.id && p.plugin) ?? f));
  };

  const togglePlugin = async (id: string, enabled: boolean) => {
    const entry = allPlugins.find((p) => p.id === id);
    if (!entry) return;
    if (entry.scope === "starter") {
      if (enabled) await addStarterPlugin(entry);
      return;
    }
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

  /** Shows the edit waiting for approval in the code view. */
  const openPending = () => {
    const file = approval?.request.kind === "change" ? approval.request.change.path : null;
    if (!file || !settleDraft(file)) return;
    setEditing(false);
    open(file);
    setReveal(file);
    setFocus("code");
  };

  /** Ask → Auto-edit (edits apply without asking) → Auto (commands too) → Ask. Undo and diffs work the same in each. */
  const autoMode = settings.autoApproveCommands ? "auto" : settings.autoApproveEdits ? "auto-edit" : "ask";
  const cycleAutoMode = (to?: "ask" | "auto-edit" | "auto") => {
    const next = to ?? (autoMode === "ask" ? "auto-edit" : autoMode === "auto-edit" ? "auto" : "ask");
    updateSettings({ autoApproveEdits: next !== "ask", autoApproveCommands: next === "auto" });
    // Whatever is waiting now falls under the new mode too.
    const kind = approval?.request.kind;
    if (kind && (next === "auto" || (next === "auto-edit" && kind === "change"))) answer(true);
    info(next === "ask" ? "Ask mode: Nou asks before every edit and command."
      : next === "auto-edit" ? "Auto-edit mode: edits apply without asking; Nou still asks before commands. Review with the diff view, u to undo."
        : "Auto mode: edits and commands run without asking. Review with the diff view, u to undo. Shift+Tab to change.");
  };

  const record = openFile ? changes.get(openFile) : undefined;
  const pendingChange = approval?.request.kind === "change" ? approval.request.change : null;
  const gitChange = useMemo(
    () => (diffMode === "git" && openFile ? diffAgainstHead(openFile, content) : null),
    [diffMode, openFile, content],
  );
  const sessionId = sessionView?.id ?? agentRef.current!.session;
  const sessionFiles = useMemo(() => timeline.sessionChanges(sessionId), [sessionId, historyVersion]);
  const sessionChange = openFile ? sessionFiles.find((c) => c.path === openFile) ?? null : null;
  const diff = (pendingChange && pendingChange.path === openFile ? pendingChange : null) ?? (diffMode === "git" ? gitChange
    : diffMode === "nou" && record ? record.change
      : diffMode === "session" ? sessionChange : null);
  const showEditor = editing && !!openFile && !(pendingChange && pendingChange.path === openFile);
  draftActiveRef.current = showEditor;

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

  /** Moves a pane border to column `x` and keeps every pane usable. */
  const moveBorder = (border: "tree" | "chat", x: number) => {
    const { treeWidth, codeWidth } = layout.current;
    const chatWidth = columns - treeWidth - codeWidth;
    const tree = border === "tree" ? Math.min(Math.max(x + 1, MIN_TREE), columns - chatWidth - MIN_CODE) : treeWidth;
    const chat = border === "chat" ? Math.min(Math.max(columns - x, MIN_CHAT), columns - treeWidth - MIN_CODE) : chatWidth;
    const next = { tree: tree / columns, chat: chat / columns };
    setPaneWidths(next);
    return next;
  };

  // Mouse: the wheel scrolls whatever pane is under the pointer; a click focuses that pane
  // (and in the file tree, opens the clicked file). Dragging a border between panes resizes them.
  useMouse((event) => {
    if (view !== "main" || quickOpen) return;
    const { treeWidth, codeWidth, paneHeight } = layout.current;
    if (event.kind === "drag") return void (dragging.current && moveBorder(dragging.current, event.x));
    if (event.kind === "release") {
      if (dragging.current) updateSettings({ paneWidths: paneWidthsRef.current });
      dragging.current = null;
      return;
    }
    if (event.y < 1 || event.y > paneHeight) return; // header or status bar
    // Each border is two columns: the left pane's edge and the right pane's.
    if (event.kind === "click" && Math.abs(event.x - (treeWidth - 0.5)) <= 1) return void (dragging.current = "tree");
    if (event.kind === "click" && Math.abs(event.x - (treeWidth + codeWidth - 0.5)) <= 1) return void (dragging.current = "chat");
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
      pullAbort.current?.abort();
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

  /** Opens a file showing its net change over the session being viewed. */
  const openSessionDiff = (file: string) => {
    if (!settleDraft(file)) return;
    open(file);
    setReveal(file);
    setDiffMode("session");
    setFocus("code");
  };

  /** [ and ]: previous / next file in the session diff. */
  const stepSessionFile = (step: number) => {
    if (!sessionFiles.length) return;
    const at = sessionFiles.findIndex((c) => c.path === openFile);
    const next = at < 0 ? 0 : (at + step + sessionFiles.length) % sessionFiles.length;
    openSessionDiff(sessionFiles[next]!.path);
  };

  const sessionLabel = (s: SessionSummary) => new Date(s.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const showSessions = () => {
    const list = timeline.sessions().slice(0, 15);
    if (!list.length) return info("No sessions with changes yet.");
    info(`Sessions with changes (newest first):\n${list.map((s, i) => {
      const current = s.id === agentRef.current!.session ? "  (this session)" : "";
      return `  ${String(i + 1).padStart(2)}. ${sessionLabel(s)}  ${s.files.length} file${s.files.length === 1 ? "" : "s"}${current}`;
    }).join("\n")}\nShow one with /diff <number>.`);
  };

  /** /diff: this session; /diff <n>: the nth session from /sessions; /diff <file>: one file of the session being viewed. */
  const showSessionDiff = (arg: string) => {
    const current = agentRef.current!.session;
    let id = current;
    let label = "this session";
    let file: string | null = null;
    if (/^\d+$/.test(arg)) {
      const picked = timeline.sessions()[Number(arg) - 1];
      if (!picked) return info(`There's no session ${arg}. See /sessions.`, "error");
      id = picked.id;
      if (id !== current) label = `session ${sessionLabel(picked)}`;
    } else if (arg) {
      file = arg.replace(/\\/g, "/").replace(/^\.\//, "");
      if (sessionView) ({ id, label } = sessionView);
    }
    const files = timeline.sessionChanges(id);
    setSessionView(id === current ? null : { id, label });
    if (!files.length) return info(`No changes in ${label}.`);
    if (file && !files.some((c) => c.path === file)) return info(`${file} didn't change in ${label}.`, "error");
    const lines = files.map((c) => {
      const { added, removed } = lineCounts(c.before, c.after);
      return `  ${c.isNew ? "A" : "M"} ${c.path}  +${added} -${removed}`;
    });
    info(`Changes in ${label} (yours and Nou's):\n${lines.join("\n")}\nShowing ${file ?? files[0]!.path}. [ ] previous/next file · v cycle diffs · Esc close.`);
    openSessionDiff(file ?? files[0]!.path);
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
    const order: DiffMode[] = ["off"];
    if (git.has(openFile)) order.push("git");
    if (record?.status === "applied") order.push("nou");
    if (sessionChange) order.push("session");
    if (order.length === 1) {
      setEntries((prev) => [...prev, { kind: "info", text: `${openFile} has no changes vs git HEAD.` }]);
      return;
    }
    setEditing(false);
    setDiffMode((m) => order[(order.indexOf(m) + 1) % order.length]!);
  };

  useInput((input, key) => {
    // A waiting approval doesn't freeze anything: y/n answer it from the tree or code view (the chat
    // handles them itself when its input is empty), Esc stops the turn, and every other key works as usual.
    if (approval && !(showEditor && focus === "code")) {
      if (key.escape) {
        agentRef.current?.cancel();
        return answer(false);
      }
      if (focus !== "chat" && /^[yYnN]$/.test(input)) return answer(/[yY]/.test(input));
      if (focus !== "chat" && input === "o" && pendingChange) return openPending();
    }
    if (key.ctrl && input === "p") {
      setQuickOpen(true);
      return;
    }
    if (showEditor && focus === "code") return; // the editor owns the keyboard
    if (key.tab && key.shift) return cycleAutoMode();
    if (key.tab) {
      setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + 1) % FOCUS_ORDER.length]!);
      return;
    }
    if (key.escape) {
      if (busy) {
        pullAbort.current?.abort();
        agentRef.current?.cancel();
      }
      else if (diffMode !== "off") {
        setDiffMode("off");
        setSessionView(null);
      }
      else setFocus("chat");
      return;
    }
    if (focus === "chat") return; // letters belong to the text box
    if (input === "f") setFollow((f) => !f);
    else if (input === "m") {
      updateSettings({ mouse: !settings.mouse });
      info(settings.mouse ? "Mouse off: drag to select text and copy it as usual in your terminal. m turns it back on." : "Mouse on: wheel scrolls, click focuses, drag borders to resize.");
    }
    else if (input === "p") {
      setCodePanel((p) => (p === "problems" ? "code" : "problems"));
      setEditing(false);
      setFocus("code");
    } else if (input === "u") undoLast();
    else if (input === "<" || input === ">") {
      // Moves the focused pane's inner border: the tree's right edge, or the code view's edge with the chat.
      const { treeWidth, codeWidth } = layout.current;
      const step = input === ">" ? 2 : -2;
      updateSettings({ paneWidths: moveBorder(focus === "tree" ? "tree" : "chat", (focus === "tree" ? treeWidth - 1 : treeWidth + codeWidth) + step) });
    } else if (input === "=") {
      setPaneWidths(null);
      updateSettings({ paneWidths: null });
    } else if (input === "v") cycleDiff();
    else if ((input === "]" || input === "[") && diffMode === "session") stepSessionFile(input === "]" ? 1 : -1);
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

  const pluginsCommand = async ([action, name]: string[]) => {
    if (action === "add") {
      const starter = starters.find((s) => s.id === name);
      if (!starter) return info(`No starter plugin "${name ?? ""}". Starters: ${starters.map((s) => s.id).join(", ")}`, "error");
      if (plugins.some((p) => p.id === starter.id)) return info(`You already have a plugin called ${starter.id}; see /settings → Plugins.`, "error");
      const added = await addStarterPlugin(starter);
      return added.error
        ? info(`Added ${added.file}, but it failed to load: ${added.error}`, "error")
        : info(`Added and switched on ${added.plugin!.name} (${added.file}). Edit that file to make it your own.`);
    }
    if (action === "new") {
      try {
        const file = scaffoldPlugin(name ?? "");
        rescanPlugins();
        return info(`Created ${path.relative(process.cwd(), file)}. Edit it, then switch it on in /settings → Plugins.`);
      } catch (error: any) {
        return info(`/plugins new: ${error.message}`, "error");
      }
    }
    if (action) return info("Usage: /plugins, /plugins add <name>, /plugins new <name>", "error");
    const mark = { on: "●", off: "○", changed: "⚠" };
    const lines = allPlugins.map((p) =>
      p.scope === "starter"
        ? `  + ${p.id.padEnd(16)} ${p.plugin?.description ?? ""}`
        : `  ${mark[trustState(p, settings)]} ${p.id.padEnd(16)} ${p.scope}${p.error ? ` · ✖ ${p.error}` : ""}`);
    return info(`Plugins (● on, ○ off, + starter you can add with /plugins add <name>):\n${lines.join("\n")}\nWrite your own: /plugins new <name>`);
  };

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
    case "diff":
      return showSessionDiff(arg);
    case "sessions":
      return showSessions();
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
      return chooseModel(resolveModel(arg));
    }
    case "copy": {
      const reply = [...entries].reverse().find((e) => e.kind === "assistant")?.text;
      const blocks = reply ? [...reply.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!) : [];
      const what = arg === "file" ? (openFile ? readText(openFile) : null) : arg === "code" ? blocks[blocks.length - 1] ?? null : reply ?? null;
      if (arg && arg !== "file" && arg !== "code") return info("Usage: /copy (the last reply) · /copy code (its last code block) · /copy file (the open file)", "error");
      if (!what) return info(arg === "file" ? "No file is open." : arg === "code" ? "The last reply has no code block." : "Nothing to copy yet.", "error");
      const ok = await copyToClipboard(what);
      return info(ok ? `Copied ${arg === "file" ? openFile : arg === "code" ? "the code block" : "the last reply"} (${what.split("\n").length} lines).` : "Couldn't reach the clipboard. Press m to turn off the mouse and select the text yourself.", ok ? "info" : "error");
    }
    case "auto": {
      if (!arg) return cycleAutoMode();
      if (arg === "ask" || arg === "auto-edit" || arg === "auto") return cycleAutoMode(arg);
      return info("Usage: /auto [ask|auto-edit|auto]", "error");
    }
    case "engine": {
      if (arg && isEngineId(arg)) return switchEngine(arg);
      if (arg) return info(`Unknown engine ${arg}. Choose one of: ${ENGINES.map((e) => e.id).join(", ")}`, "error");
      const current = agentRef.current!.id;
      const lines = ENGINES.map((e) => `  ${e.id === current ? "●" : "○"} ${e.id.padEnd(12)} ${e.description}${isInstalled(e) ? "" : ` (not installed: switching runs npm install ${e.package})`}`);
      return info(`Engines (/engine <name> to switch, or /settings → Engine):\n${lines.join("\n")}`);
    }
    case "pull": {
      if (!arg) return info("Usage: /pull <model>, e.g. /pull qwen3:8b. Browse models at https://ollama.com/library", "error");
      const model = arg.replace(/^ollama:/, "");
      if (await pullModel(model)) info(`Use it with /model ollama:${model}`);
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
    case "compact": {
      const engine = agentRef.current!;
      if (!engine.compact) return info(`${engineInfo(engine.id).label} manages its own context.`);
      if (busy) return info("Wait for the current reply to finish first.", "error");
      setBusy("Summarizing the conversation...");
      try {
        if (!(await engine.compact(true))) info("Nothing to compact yet.");
      } catch (error: any) {
        info(`Couldn't compact: ${error.message}`, "error");
      } finally {
        setBusy(null);
      }
      return;
    }
    case "clear":
      agentRef.current!.clear();
      setEntries([]);
      return;
    case "plugins":
      return pluginsCommand(rest);
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
        onModel={(next) => void chooseModel(next)}
        onEngine={(id) => void switchEngine(id)}
        onChange={updateSettings}
        onTogglePlugin={(id, enabled) => void togglePlugin(id, enabled)}
        onRescanPlugins={rescanPlugins}
        onClose={() => setView("main")}
      />
    );
  }

  const height = Math.max(10, rows - 2);
  const treeWidth = paneWidths ? Math.max(MIN_TREE, Math.round(columns * paneWidths.tree)) : Math.max(24, Math.floor(columns * 0.2));
  const chatWidth = paneWidths ? Math.max(MIN_CHAT, Math.min(Math.round(columns * paneWidths.chat), columns - treeWidth - MIN_CODE)) : Math.max(34, Math.floor(columns * 0.3));
  const codeWidth = Math.max(MIN_CODE, columns - treeWidth - chatWidth);
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

  // Shortcuts for the status bar, most useful first; the ones that don't fit are left out (all of them are in /help).
  const hints: [string, string][] = approval && !(showEditor && focus === "code")
    ? [["y", "accept"], ["n", "reject"], ...(pendingChange && diff !== pendingChange ? [["o", "show the edit"] as [string, string]] : []), ["Esc", "stop"], ["Shift+Tab", "auto mode"]]
    : showEditor && focus === "code"
      ? [["Esc", "done"], ["Ctrl+S", settings.autoSave === "off" ? "save" : "save (auto-save on)"], ["Ctrl+Z", "undo"], ["Ctrl+Y", "redo"], ["Ctrl+K", "info"], ["Ctrl+G", "definition"]]
      : focus === "chat"
        ? busy
          ? [["Esc", "stop"], ["Shift+↑↓", "scroll"], ["Tab", "next pane"]]
          : [["Enter", "send"], ["/", "commands"], ["Tab", "next pane"], ["Ctrl+P", "find file"], ["Shift+↑↓", "scroll"]]
        : focus === "tree"
          ? [["Enter", "open"], ["e", "edit"], ["c", "changes"], ["Ctrl+P", "find"], ["u", "undo"], ["p", "problems"], ["< >", "resize"], ["m", "select text"], ["s", "settings"]]
          : diff
            ? [["Esc", "close diff"], ["n/N", "next/prev change"], ...(diffMode === "session" ? [["[ ]", "prev/next file"] as [string, string]] : []), ["v", "cycle diff"]]
            : [["e", "edit"], ["v", "diff"], ["u", "undo"], ["p", "problems"], ["< >", "resize"], ["m", "select text"], ["s", "settings"]];
  const statusUsed = mode.label.length + 2 + autoMode.length + 2 + 10 + ` ✖ ${totals.errors} ▲ ${totals.warnings} `.length + (checking.length ? 4 + checking.join(", ").length : 0) + 2;
  const shownHints: [string, string][] = [];
  for (let used = statusUsed, i = 0; i < hints.length; i++) {
    used += hints[i]![0].length + hints[i]![1].length + 4;
    if (used > columns) break;
    shownHints.push(hints[i]!);
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header width={columns} branch={branch} changes={git.size} model={agentRef.current!.id === "nou" ? describe(choice) : `${engineInfo(agentRef.current!.id).label} · ${engineInfo(agentRef.current!.id).model(choice)}`} local={choice.provider.local} busy={busy} update={update} />
      <Box flexDirection="row" height={height}>
        <FileTree
          width={treeWidth}
          height={height}
          focused={focus === "tree"}
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
            focused={focus === "code"}
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
            focused={focus === "code"}
            filePath={openFile}
            content={content}
            diff={diff}
            diffLabel={diffMode === "git" ? "vs HEAD" : diffMode === "session" ? sessionView?.label ?? "this session" : "Nou's edit"}
            pending={!!pendingChange && diff === pendingChange}
            marked={record?.lines ?? NO_LINES}
            problems={fileProblems}
            focusLine={focusLine}
            syntaxVersion={syntaxVersion}
            diffNote={pendingChange && diff === pendingChange ? pendingNote?.short ?? (checking.length ? "checking…" : null) : null}
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
          onAnswer={answer}
        />
      </Box>
      <Box>
        <Text wrap="truncate-end">
          <Text backgroundColor={mode.color} color="black" bold>{` ${mode.label} `}</Text>
          <Text backgroundColor={C.panel} color={autoMode === "ask" ? C.dim : C.orange} bold={autoMode !== "ask"}>{` ${autoMode === "ask" ? "ask" : autoMode} `}</Text>
          <Text backgroundColor={C.panel} color={follow ? C.green : C.dim}>{follow ? " ◉ follow " : " ○ follow "}</Text>
          <Text backgroundColor={C.panel} color={totals.errors ? C.red : C.dim}>{` ✖ ${totals.errors}`}</Text>
          <Text backgroundColor={C.panel} color={totals.warnings ? C.yellow : C.dim}>{` ▲ ${totals.warnings} `}</Text>
          {checking.length > 0 && <Text color={C.accent2}> ⟳ {checking.join(", ")}</Text>}
          {exitArmed
            ? <Text color={C.yellow} bold>{"  "}Press again to quit{draft.current && settings.autoSave === "off" ? ` (unsaved changes in ${draft.current.path} will be lost)` : ""}</Text>
            : shownHints.map(([key, action], i) => (
              <Text key={key}>{i === 0 ? "  " : <Text color={C.dim}> · </Text>}<Text color={C.text}>{key}</Text><Text color={C.dim}> {action}</Text></Text>
            ))}
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
