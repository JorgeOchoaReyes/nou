import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { buildSystemPrompt, type AgentHooks, type ApprovalRequest, type ChangeStatus, type ChatEntry } from "../agent/index.js";
import { ENGINES, createEngine, engineInfo, installEngine, isEngineId, isInstalled, type Engine, type EngineId, type EngineOptions } from "../engines/index.js";
import { harness, problemsIntroduced } from "../agent/harness.js";
import { describe, providers, resolveModel, saveModel, setupProblem, type ModelChoice, type Provider } from "../providers/index.js";
import { sameModel } from "../providers/ollama.js";
import type { FileChange } from "../commands/index.js";
import { FOLLOW_SPEEDS, loadSettings, saveSettings, type Settings as SettingsType } from "../config/index.js";
import { branch as gitBranch, diffAgainstHead, isRepo, sameStatus, status as gitStatus, statusAsync as gitStatusAsync, type GitStatus } from "../git/index.js";
import { BUILTIN_PLUGINS, addStarter, discoverPlugins, isEnabled, loadPlugin, scaffoldPlugin, starterPlugins, trustPatch, trustState, type PluginEntry } from "../plugins/index.js";
import { DiagnosticsManager, formatDiagnostic, newProblems } from "../diagnostics/index.js";
import { Timeline, type SessionSummary } from "../history/index.js";
import { lsp } from "../lsp/index.js";
import { onGrammarLoaded, preload } from "../syntax/index.js";
import { setCodeTheme } from "../syntax/themes.js";
import { checkForUpdate, currentVersion } from "../update/index.js";
import { changedLines, lineCounts, loadFallbackHighlighter, type FileRef } from "./text.js";
import { findDefinition, wordAt } from "./definition.js";
import { ProblemsView } from "./ProblemsView.js";
import { useMouse } from "./mouse.js";
import { C } from "./theme.js";
import { FileTree } from "./FileTree.js";
import { CodeView } from "./CodeView.js";
import { Editor, type EditorMouse, type EditorState } from "./Editor.js";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
import { WHEEL_STEP, type ScrollTo, type Wheel } from "./scroll.js";
import { Chat } from "./Chat.js";
import { copyToClipboard } from "./clipboard.js";
import { Header } from "./Header.js";
import { Tabs, layoutTabs } from "./Tabs.js";
import { QuickOpen, listAllFiles, score, type PaletteAction } from "./QuickOpen.js";
import { Settings } from "./Settings.js";

type Focus = "tree" | "code" | "chat";
type DiffMode = "off" | "git" | "nou" | "session";
const FOCUS_ORDER: Focus[] = ["tree", "code", "chat"];
const MIN_TREE = 14;
const MIN_CODE = 20;
const MIN_CHAT = 24;
const NO_LINES = new Set<number>();
const DOUBLE_CLICK_MS = 500;
/** A step follow mode shows: a file the agent read, and the lines when it read part of it. */
type FollowStep = { file: string; line?: number; to?: number };
/** How long each follow step stays on screen before the next. */
const FOLLOW_STEP_MS: Record<string, number> = { slow: 2500, normal: 1200, fast: 450, instant: 0 };
/** Steps follow mode may fall behind before it skips ahead. */
const MAX_FOLLOW_LAG = 12;
/** Columns the tabs get in the code view's title, leaving room for the scroll position and badges. */
const tabsWidth = (codeWidth: number) => Math.max(16, codeWidth - 16);

type Props = { initialModel: ModelChoice; permContext: string };

/** How much of the conversation a newly switched-to engine is given (the latest part when it's longer). */
const HANDOFF_CHARS = 24_000;

/** The conversation so far as text, for an engine taking over from another one; null when there's none. */
export function conversationSoFar(entries: ChatEntry[]): string | null {
  const said = entries
    .filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool")
    .map((e) => (e.kind === "user" ? `User: ${e.text}` : e.kind === "assistant" ? `Assistant: ${e.text}` : `(${e.text})`));
  if (!said.some((line) => line.startsWith("User:"))) return null;
  let text = said.join("\n\n");
  if (text.length > HANDOFF_CHARS) text = `[earlier messages left out]\n${text.slice(-HANDOFF_CHARS)}`;
  return `You are taking over a conversation the user was having with another assistant in this project. Here it is, so you can carry on from where it left off (the files may have changed since; check before relying on them):\n<conversation>\n${text}\n</conversation>`;
}
/** A clickable stretch of the status bar, in columns. */
type StatusZone = { from: number; to: number; run(): void };

/** /help: every command from the shared list, then the keys. */
const HELP = `Commands (type / in the chat for a menu, or press ? for every action):
${SLASH_COMMANDS.map((c) => `  /${`${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(30)} ${c.description}`).join("\n")}
Keys:
  ?  every action, searchable (also Ctrl+P then >)   Ctrl+P  find a file
  Tab  switch pane      Esc  stop / back
  Shift+Tab  ask / auto-edit / auto                < > resize pane  = reset
  m  mouse on/off (off: select text to copy; Shift+drag also works in most terminals)
  /  start a command from any pane
  e  edit open file (or double-click in the code)  v  diff (git / Nou / session)  f  follow mode
  Ctrl+F  find in the open file (Enter/↓ next, ↑ previous)
  b  back to the previous file (Ctrl+P lists recent files first)   [ ]  previous/next tab · x close tab
  Ctrl+click, Option+click or right-click a name: go to its definition (an import's path opens the file)
  p  problems              u    undo Nou's edit   s   settings
  c  (in files) show only changed files            Ctrl+C twice  quit
Mouse: wheel scrolls (Shift+wheel sideways) · click/drag a scrollbar · double-click in the code to edit there (in the editor: select a word), drag to select
In the editor:
  Shift+arrows / mouse drag select · Ctrl+A all · Ctrl+C/X/V copy/cut/paste · Esc clear selection or leave
  Ctrl+←/→ word · Ctrl+Backspace or Ctrl+W delete word · Ctrl+Home/End file start/end
  Ctrl+F find · Ctrl+L go to line · Ctrl+/ comment · Ctrl+D duplicate line · Alt+↑/↓ move line
  Tab/Shift+Tab indent/outdent · Ctrl+S save · Ctrl+Z/Y undo/redo · Ctrl+K info · Ctrl+G go to definition`;

/** A callback that keeps one identity across renders but always runs the latest code, so memoized panes don't re-render for it. */
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

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
  setCodeTheme(settings.codeTheme); // before anything below highlights code
  const [view, setView] = useState<"main" | "settings">("main");
  const [connectTo, setConnectTo] = useState<Provider | undefined>();
  /** Why settings were opened for you (a request failed on the provider's setup). */
  const [setupReason, setSetupReason] = useState<string | null>(null);
  /** The file finder / command palette: closed (null), or open with this query (">" for commands). */
  const [quickOpen, setQuickOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("chat");
  const [follow, setFollow] = useState(settings.followMode);
  // Follow mode replays what the agent reads a step at a time (it reads far faster than you can watch):
  // the steps waiting, and the timer that shows the next one.
  const followQueue = useRef<FollowStep[]>([]);
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [followLag, setFollowLag] = useState(0);
  const clearFollow = () => {
    followQueue.current = [];
    if (followTimer.current) clearTimeout(followTimer.current);
    followTimer.current = null;
    setFollowLag(0);
  };
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
  /** The open files, as tabs over the code view, in the order they were opened. */
  const [tabs, setTabs] = useState<string[]>([]);
  /** Files opened this session, latest first: Ctrl+P lists them first, and b goes back to the previous one. */
  const [recent, setRecent] = useState<string[]>([]);
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
  // The editor reports every keystroke; the app only re-renders when what it shows changes (line, unsaved, selection).
  const editorStateRef = useRef<EditorState | null>(null);
  const [editorState, setEditorState] = useState<{ line: number; dirty: boolean; selection: boolean } | null>(null);
  const editorProblemsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Unsaved editor text survives switching to a diff and back.
  const draft = useRef<{ path: string; text: string; baseline: string } | null>(null);
  const [codePanel, setCodePanel] = useState<"code" | "problems">("code");
  const [diagnosticsVersion, setDiagVersion] = useState(0);
  const [syntaxVersion, setSyntaxVersion] = useState(0);
  const [focusLine, setFocusLine] = useState<{ line: number; to?: number; path?: string; nonce: number } | null>(null);
  const [editorStart, setEditorStart] = useState<{ line: number; col?: number; nonce: number }>({ line: 1, nonce: 0 });
  const [pendingNote, setPendingNote] = useState<{ short: string; detail: string | null } | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const [update, setUpdate] = useState<string | null>(null);
  const [wheel, setWheel] = useState<(Wheel & { pane: Focus }) | null>(null);
  const [scrollTo, setScrollTo] = useState<(ScrollTo & { pane: Focus }) | null>(null);
  const [editorMouse, setEditorMouse] = useState<EditorMouse[]>([]);
  /** Wheel events waiting for the next frame, added up per pane. */
  const pendingWheel = useRef<{ pane: Focus; lines: number; columns: number; timer: ReturnType<typeof setTimeout> | null }>({ pane: "chat", lines: 0, columns: 0, timer: null });
  /** The chat's command menu is open (Tab completes there instead of switching panes). */
  const chatMenuOpen = useRef(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [treeClick, setTreeClick] = useState<{ row: number; nonce: number } | null>(null);
  /** Whether the code view's find bar is open (it takes the keyboard). */
  const codeFinding = useRef(false);
  const onCodeFinding = useCallback((open: boolean) => {
    codeFinding.current = open;
  }, []);
  /** Bumped to open the code view's find bar from outside it (the palette, the status bar). */
  const [findRequest, setFindRequest] = useState(0);
  const startFind = () => {
    if (!openFile) return info("Open a file first (Ctrl+P), then Ctrl+F searches it.");
    setDiffMode("off");
    setEditing(false);
    setCodePanel("code");
    setFocus("code");
    setFindRequest((n) => n + 1);
  };
  const [codeDefine, setCodeDefine] = useState<{ row: number; x: number; nonce: number } | null>(null);
  const [chatClick, setChatClick] = useState<{ row: number; col: number; nonce: number } | null>(null);
  // Pane geometry from the last render, so mouse events can be mapped to the pane under the pointer.
  const layout = useRef({ treeWidth: 0, codeWidth: 0, paneHeight: 0 });
  /** Pane widths while a border is dragged (saved on release); the saved ones otherwise. */
  const [paneWidths, setPaneWidths] = useState(settings.paneWidths);
  const paneWidthsRef = useRef(paneWidths);
  paneWidthsRef.current = paneWidths;
  /** What a mouse drag is moving: a pane border, a pane's scrollbar, or the editor's selection. */
  /** Where the status bar's parts and the header's model badge are, from the last render. */
  const clickable = useRef<{ status: StatusZone[]; modelFrom: number }>({ status: [], modelFrom: Infinity });
  const lastClick = useRef<{ x: number; y: number; time: number } | null>(null);
  const dragging = useRef<"tree" | "chat" | "editor" | { scroll: Focus } | null>(null);
  /** Which border is being dragged, for the status bar. */
  const [resizing, setResizing] = useState<"tree" | "chat" | null>(null);
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
  const allFiles = useMemo(() => (quickOpen !== null ? listAllFiles() : []), [quickOpen !== null]);
  const repo = useMemo(() => isRepo(), []);
  const branch = useMemo(() => (repo ? gitBranch() : null), [repo, git]);

  const open = useCallback((filePath: string) => {
    setOpenFile(filePath);
    setRecent((r) => [filePath, ...r.filter((f) => f !== filePath)].slice(0, 30));
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
      onEntry: (entry) => {
        setEntries((prev) => [...prev, entry]);
        if (entry.kind === "error") setupCheckRef.current(entry.text);
      },
      onStream: showStream,
      onBusy: setBusy,
      onOpen: (filePath, line, to) => {
        clearFollow(); // what was asked for wins over reads still waiting to be shown
        openAtRef.current(filePath, line ?? 1, false, to);
      },
      onRead: (filePath, line, to) => followStepRef.current({ file: filePath, ...(line ? { line } : {}), ...(to ? { to } : {}) }),
      onChange: (change, status, turn) => {
        if (status === "applied") {
          timelineRef.current!.record({ path: change.path, before: change.isNew ? null : change.before, after: change.after, source: "nou", turn });
        }
        const lines = status === "applied" ? changedLines(change.before, change.after) : NO_LINES;
        setChanges((prev) => new Map(prev).set(change.path, { change, status, lines }));
        // Diffs awaiting approval are shown unless you're in the middle of editing a file (the chat says what's waiting).
        if ((status === "pending" && !draftActiveRef.current) || followRef.current) {
          clearFollow(); // an edit is shown as it happens, ahead of reads still waiting
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
  useEffect(() => setSyntaxVersion((v) => v + 1), [settings.codeTheme]); // re-color the code
  useEffect(() => void loadFallbackHighlighter(), []); // once Nou is on screen (it's slow to load)
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
  const pluginCommands = useMemo<SlashCommand[]>(
    () => activePlugins.flatMap((p) => (p.plugin!.commands ?? []).map((c) => ({ name: c.name, args: "[args]", description: `${c.description} (${p.plugin!.name})` }))),
    [activePlugins],
  );

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
    const handoff = conversationSoFar(entries);
    if (handoff) engine.note(handoff);
    info(`Now using the ${target.label} engine (model: ${target.model(choice)}). ${handoff ? "It has the conversation so far." : "This starts a new conversation."}${target.approvals === "after" ? " It edits without asking first; review its changes in the diff view and press u to undo." : ""}`);
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

  // Derived values handed to the panes keep their identity until they really change, so a pane that
  // didn't change skips re-rendering (memo) instead of redrawing on every keystroke elsewhere.
  const edited = useMemo(() => new Set([...changes].filter(([, c]) => c.status === "applied").map(([p]) => p)), [changes]);
  const problemCounts = useMemo(() => diagnostics.fileCounts(), [diagnosticsVersion]);
  const fileProblems = useMemo(() => (openFile ? diagnostics.get(openFile) : []), [openFile, diagnosticsVersion]);
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

  /** Adds a wheel event to its pane's total; the panes get one update per frame however many events arrive. */
  const lastVerticalWheel = useRef(0);
  const queueWheel = (pane: Focus, dir: number, horizontal: boolean) => {
    // A trackpad scrolling down also sends stray sideways steps: while scrolling up or down, ignore them.
    if (!horizontal) lastVerticalWheel.current = Date.now();
    else if (Date.now() - lastVerticalWheel.current < 300) return;
    const q = pendingWheel.current;
    if (q.timer && q.pane !== pane) flushWheel();
    q.pane = pane;
    if (horizontal) q.columns += dir * WHEEL_STEP;
    else q.lines += dir * WHEEL_STEP;
    q.timer ??= setTimeout(flushWheel, 16);
  };
  const flushWheel = () => {
    const q = pendingWheel.current;
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    if (!q.lines && !q.columns) return;
    const { pane, lines, columns } = q;
    q.lines = 0;
    q.columns = 0;
    setWheel((w) => ({ pane, lines, columns, nonce: (w?.nonce ?? 0) + 1 }));
  };

  /** Scrolls a pane to where its scrollbar was clicked or dragged (rows start at y=3, under the border and title). */
  const scrollPane = (pane: Focus, y: number) => {
    const { paneHeight } = layout.current;
    const fraction = (y - 3) / Math.max(1, paneHeight - 4);
    setScrollTo((s) => ({ pane, fraction, nonce: (s?.nonce ?? 0) + 1 }));
  };

  // Mouse: the wheel scrolls whatever pane is under the pointer (Shift+wheel sideways); a click focuses
  // that pane, opens the clicked file in the tree, and puts the cursor where you clicked in the code
  // (starting the editor). Drag to select in the editor, drag a scrollbar to scroll, drag the border
  // between panes to resize them.
  useMouse((event) => {
    if (view !== "main" || quickOpen !== null) return;
    const { treeWidth, codeWidth, paneHeight } = layout.current;
    const codeLeft = treeWidth;
    const editorAt = (x: number, y: number, kind: EditorMouse["kind"]) =>
      setEditorMouse((m) => [...m.slice(-15), { x: x - codeLeft - 1, y: y - 3, kind, seq: (m[m.length - 1]?.seq ?? 0) + 1 }]);
    if (event.kind === "drag") {
      lastClick.current = null; // a press that became a drag doesn't start a double-click
      const drag = dragging.current;
      if (drag === "tree" || drag === "chat") moveBorder(drag, event.x);
      else if (drag === "editor") editorAt(event.x, event.y, "drag");
      else if (drag) scrollPane(drag.scroll, event.y);
      return;
    }
    if (event.kind === "release") {
      // The release says where the button let go, so a drag lands there even in a terminal that
      // doesn't report the movement in between.
      if (dragging.current === "tree" || dragging.current === "chat") {
        updateSettings({ paneWidths: moveBorder(dragging.current, event.x) });
        setResizing(null);
      } else if (dragging.current && typeof dragging.current === "object") scrollPane(dragging.current.scroll, event.y);
      if (dragging.current === "editor") editorAt(event.x, event.y, "release");
      dragging.current = null;
      return;
    }
    if (event.kind === "click" && !approval && event.y === 0 && event.x >= clickable.current.modelFrom) return setView("settings");
    if (event.kind === "click" && event.y === paneHeight + 1) return clickable.current.status.find((z) => event.x >= z.from && event.x < z.to)?.run();
    if (event.y < 1 || event.y > paneHeight) return; // header or status bar
    const pane: Focus = event.x < treeWidth ? "tree" : event.x < treeWidth + codeWidth ? "code" : "chat";
    if (event.kind === "wheel") return queueWheel(pane, event.dir, event.horizontal);
    // Each border is two columns: the left pane's edge and the right pane's.
    // On the panes' top border row, a little either side of a border grabs it too: an easier target.
    const reach = event.y === 1 ? 2 : 1;
    for (const border of ["tree", "chat"] as const) {
      const edge = border === "tree" ? treeWidth - 0.5 : treeWidth + codeWidth - 0.5;
      if (Math.abs(event.x - edge) <= reach) {
        dragging.current = border;
        setResizing(border);
        return;
      }
    }
    // Each pane's scrollbar is the column inside its right border.
    const scrollbarX = pane === "tree" ? treeWidth - 2 : pane === "code" ? treeWidth + codeWidth - 2 : columns - 2;
    if (event.x === scrollbarX && event.y >= 3) {
      dragging.current = { scroll: pane };
      scrollPane(pane, event.y);
      return;
    }
    // The code view's title row holds the tabs: a click switches, the × closes.
    if (event.kind === "click" && pane === "code" && event.y === 2 && tabs.length >= 2 && !diff) {
      const zone = layoutTabs(tabs, openFile, tabsWidth(codeWidth)).zones.find((z) => event.x - codeLeft - 1 >= z.from && event.x - codeLeft - 1 < z.to);
      if (!zone) return;
      if (zone.close !== null && Math.abs(event.x - codeLeft - 1 - zone.close) <= 1) closeTab(zone.file);
      else switchTab(zone.file);
      return;
    }
    // Ctrl/Alt+click or right-click on code: go to the definition of what's under the pointer.
    if (event.kind === "click" && event.define && pane === "code" && event.y >= 3 && codePanel === "code") {
      lastClick.current = null;
      setFocus("code");
      if (showEditor) editorAt(event.x, event.y, "define");
      else if (openFile && !diff) setCodeDefine((d) => ({ row: event.y - 3, x: event.x - codeLeft - 1, nonce: (d?.nonce ?? 0) + 1 }));
      return;
    }
    if (approval) return;
    setFocus(pane);
    // Rows start under the pane's top border (y=1) and title (y=2).
    if (pane === "tree" && event.y >= 3) setTreeClick((c) => ({ row: event.y - 3, nonce: (c?.nonce ?? 0) + 1 }));
    // Messages start after the chat's border and the two-column bar in front of each line.
    if (pane === "chat" && event.y >= 3) setChatClick((c) => ({ row: event.y - 3, col: event.x - treeWidth - codeWidth - 3, nonce: (c?.nonce ?? 0) + 1 }));
    // Two clicks in the same spot within half a second are a double-click.
    const last = lastClick.current;
    const double = !!last && Date.now() - last.time < DOUBLE_CLICK_MS && Math.abs(last.x - event.x) <= 1 && last.y === event.y;
    lastClick.current = double ? null : { x: event.x, y: event.y, time: Date.now() };
    if (pane === "code" && event.y >= 3 && codePanel === "code") {
      if (showEditor) {
        dragging.current = "editor";
        editorAt(event.x, event.y, double ? "double" : "press");
      } else if (double && openFile && !diff && settleDraft(openFile)) {
        // Double-click in the code: edit right there.
        const gutter = String(content.split("\n").length).length + 1;
        setEditorStart((s) => ({ line: (viewport?.top ?? 1) + event.y - 3, col: Math.max(1, event.x - codeLeft - gutter), nonce: s.nonce + 1 }));
        setDiffMode("off");
        setEditing(true);
      }
    }
  }, settings.mouse);

  // Ctrl+C: stop Nou if it's working; otherwise press twice to quit.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (showEditor && focus === "code" && editorStateRef.current?.selection) return; // the editor copies it
    if (busy || approval) {
      stop();
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

  /**
   * Opens a file at a line, in the editor if `edit` (used by the Problems list and go-to-definition).
   * With `to`, lines `line` to `to` are highlighted: something the user asked Nou to find.
   */
  const openAt = (file: string, line: number, edit = false, to?: number) => {
    if (!settleDraft(file)) return;
    if (file !== openFile) open(file);
    setReveal(file);
    setCodePanel("code");
    if (edit) {
      setEditorStart((s) => ({ line, nonce: s.nonce + 1 }));
      setEditing(true);
      setFocus("code");
    } else {
      setFocusLine((f) => ({ line, ...(to !== undefined ? { to, path: file } : {}), nonce: (f?.nonce ?? 0) + 1 }));
    }
  };
  // Every file that's shown gets a tab (however it was opened: the tree, Nou, a link...).
  useEffect(() => {
    if (openFile) setTabs((t) => (t.includes(openFile) ? t : [...t, openFile].slice(-20)));
  }, [openFile]);
  /** Switches to another open file's tab. */
  const switchTab = (file: string) => {
    if (file === openFile || !settleDraft(file)) return;
    open(file);
    setReveal(file);
  };
  const cycleTab = (step: number) => {
    if (tabs.length < 2 || !openFile) return;
    const i = tabs.indexOf(openFile);
    switchTab(tabs[(i + step + tabs.length) % tabs.length]!);
  };
  /** Closes a tab (the open file's by default), moving to its neighbour. */
  const closeTab = (file = openFile) => {
    if (!file) return;
    const i = tabs.indexOf(file);
    const rest = tabs.filter((f) => f !== file);
    if (file !== openFile) return setTabs(rest);
    const next = rest[Math.min(Math.max(0, i), rest.length - 1)];
    if (!settleDraft(next ?? "")) return;
    if (draft.current?.path === file) draft.current = null;
    setTabs(rest);
    if (next) {
      open(next);
      setReveal(next);
    } else {
      setOpenFile(null);
      setContent("");
      setEditing(false);
      setDiffMode("off");
    }
  };
  const showFollowStep = (step: FollowStep) => {
    if (step.line) openAt(step.file, step.line, false, step.to ?? step.line);
    else if (step.file !== openFile) {
      if (!settleDraft(step.file)) return;
      open(step.file);
      setReveal(step.file);
    }
  };
  const showFollowRef = useRef(showFollowStep);
  showFollowRef.current = showFollowStep;
  /** Shows the next waiting step, then waits as long as the follow speed says before the one after. */
  const playFollow = () => {
    const step = followQueue.current.shift();
    setFollowLag(followQueue.current.length);
    if (!step) {
      followTimer.current = null;
      return;
    }
    showFollowRef.current(step);
    followTimer.current = setTimeout(playFollow, FOLLOW_STEP_MS[settingsRef.current.followSpeed] ?? FOLLOW_STEP_MS.normal);
  };
  const followStep = (step: FollowStep) => {
    if (!followRef.current) return;
    if (!FOLLOW_STEP_MS[settings.followSpeed]) return showFollowStep(step);
    followQueue.current.push(step);
    // Never fall too far behind: past that, the oldest steps are skipped.
    if (followQueue.current.length > MAX_FOLLOW_LAG) followQueue.current.splice(0, followQueue.current.length - MAX_FOLLOW_LAG);
    setFollowLag(followQueue.current.length);
    if (!followTimer.current) playFollow();
  };
  const followStepRef = useRef(followStep);
  followStepRef.current = followStep;
  useEffect(() => {
    if (!follow) clearFollow();
  }, [follow]);
  const openAtRef = useRef(openAt);
  openAtRef.current = openAt;
  /** A file named in the chat (clicked, or shown by Nou): open it there, highlighting the lines it names. */
  const openRef = useEvent((ref: FileRef) => {
    const file = path.relative(process.cwd(), path.resolve(ref.path)).replace(/\\/g, "/");
    openAt(file, ref.line ?? 1, false, ref.line ? ref.to ?? ref.line : undefined);
  });

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
        stop();
        return answer(false);
      }
      if (focus !== "chat" && /^[yYnN]$/.test(input)) return answer(/[yY]/.test(input));
      if (focus !== "chat" && input === "o" && pendingChange) return openPending();
    }
    if (key.ctrl && input === "p") {
      setQuickOpen("");
      return;
    }
    if (showEditor && focus === "code") return; // the editor owns the keyboard
    if (focus === "code" && codeFinding.current) return; // so does the find bar
    if (key.tab && key.shift) return cycleAutoMode();
    if (key.tab && focus === "chat" && chatMenuOpen.current) return; // Tab completes the command
    if (key.tab) {
      setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + 1) % FOCUS_ORDER.length]!);
      return;
    }
    if (key.escape) {
      if (busy) stop();
      else if (diffMode !== "off") {
        setDiffMode("off");
        setSessionView(null);
      }
      else setFocus("chat");
      return;
    }
    if (focus === "chat") return; // letters belong to the text box
    if (input === "?") setQuickOpen(">"); // every action, searchable
    else if (input === "/") {
      // Commands work from anywhere: / jumps to the chat's command box.
      setFocus("chat");
      setChatPrefill((p) => ({ text: "/", nonce: (p?.nonce ?? 0) + 1 }));
    } else if (input === "f") setFollow((f) => !f);
    else if (input === "m") toggleMouse();
    else if (input === "p") toggleProblems();
    else if (input === "u") undoLast();
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
    else if (input === "]" || input === "[") cycleTab(input === "]" ? 1 : -1);
    else if (input === "x") closeTab();
    else if (input === "e") startEditing();
    else if (input === "b") goBack();
    else if (input === "s" || input === ",") setView("settings");
    else if (input === "r") {
      refreshGit();
      setTreeVersion((v) => v + 1);
    } else if (input === "q") requestQuit();
  }, { isActive: view === "main" && quickOpen === null && !(codePanel === "problems" && focus === "code") });

  /** What the user is looking at, attached to each message so "this file" / "here" make sense. */
  const editorContext = (): string | null => {
    if (!openFile) return null;
    const editorState = editorStateRef.current;
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
    case "open": {
      // A path (with :line or :line-line), or part of a file's name.
      const m = arg.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/)!;
      const wanted = m[1]!.replace(/^\.\//, "");
      if (!wanted) return info("Usage: /open <file>[:line] (part of the name is enough), or ask in the chat where something is.", "error");
      const files = listAllFiles();
      const file = files.includes(wanted) ? wanted : files
        .map((f) => ({ f, m: score(f, wanted) }))
        .filter((r) => r.m)
        .sort((a, b) => b.m!.score - a.m!.score)[0]?.f;
      if (!file) return info(`No file matches "${wanted}". To find where something is in the code, ask in the chat.`, "error");
      return openRef({ path: file, ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { to: Number(m[3]) } : {}) });
    }
    case "problems":
      setCodePanel("problems");
      setFocus("code");
      return;
    case "settings":
      setConnectTo(undefined);
      setView("settings");
      return;
    case "connect": {
      const provider = providers.find((p) => p.id === arg.toLowerCase());
      const choices = providers.filter((p) => p.connect).map((p) => p.id).join(", ");
      if (!provider) return info(arg ? `Unknown provider "${arg}". Choose one of: ${choices}` : `Usage: /connect <provider>, one of: ${choices}`, "error");
      if (!provider.connect) return info(`${provider.label} needs nothing to connect.`);
      setConnectTo(provider);
      setView("settings");
      return;
    }
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

  /** Takes you to where the provider's setup is fixed: its key and URL form, or its list of models. */
  const fixSetup = (provider: Provider, reason: string, form: boolean) => {
    setConnectTo(form && provider.connect ? provider : undefined);
    setSetupReason(reason);
    setView("settings");
  };
  // A request that failed because of the provider's setup (not the request) opens the fix for it.
  const setupCheck = (error: string) => {
    if (agentRef.current?.id !== "nou") return;
    const provider = choice.provider;
    const problem = setupProblem(provider, error);
    if (!problem) return;
    const what = problem === "key" ? "the key was rejected" : problem === "url" ? "its URL didn't answer" : "it doesn't have that model";
    info(`${provider.label}: ${what}. Opened its settings to fix it (Esc to come back).`);
    fixSetup(provider, error.split("\n")[0]!, problem !== "model");
  };
  const setupCheckRef = useRef(setupCheck);
  setupCheckRef.current = setupCheck;
  /** Messages sent while Nou works: each goes when it finishes, in order. */
  const [queued, setQueued] = useState<string[]>([]);
  /** Set when you stop Nou: what was queued goes back into the input instead of being sent. */
  const stopped = useRef(false);
  const stop = () => {
    pullAbort.current?.abort();
    agentRef.current?.cancel();
    stopped.current = true;
  };
  useEffect(() => {
    if (busy || approval || !queued.length) return;
    if (stopped.current) {
      stopped.current = false;
      setChatPrefill((p) => ({ text: queued.join("\n"), nonce: (p?.nonce ?? 0) + 1 }));
      setQueued([]);
      return;
    }
    const [next, ...rest] = queued;
    setQueued(rest);
    send(next!);
  }, [busy, approval, queued]);
  useEffect(() => {
    if (busy) stopped.current = false;
  }, [busy]);
  /** From the chat: while Nou works, a message waits its turn, or (`now`) stops Nou and goes right away. */
  const submit = (text: string, now = false) => {
    if (!busy) return send(text);
    if (now) {
      stop();
      stopped.current = false; // this one is meant to go
      setQueued((q) => [text, ...q]);
    } else setQueued((q) => [...q, text]);
  };
  const send = (text: string) => {
    if (text.startsWith("/")) {
      void runCommand(text);
      return;
    }
    const missing = agentRef.current?.id === "nou" ? choice.provider.unavailable() : null;
    if (missing) {
      info(`${choice.provider.label} isn't set up yet (${missing}). Opened its settings: enter what it needs, then send again.`, "error");
      fixSetup(choice.provider, `${choice.provider.label} isn't set up: ${missing}`, true);
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

  // Stable callbacks for the memoized panes.
  const onTreeOpen = useEvent((filePath: string) => {
    open(filePath);
    setFocus("code");
  });
  const onTreeHover = useEvent(() => {});
  const onJump = useEvent((file: string, line: number) => openAt(file, line));
  const onCloseProblems = useEvent(() => setCodePanel("code"));
  const onViewport = useEvent((top: number, bottom: number) => setViewport((v) => (v?.top === top && v.bottom === bottom ? v : { top, bottom })));
  const onSend = useEvent(submit);
  const onChatMenu = useEvent((open: boolean) => {
    chatMenuOpen.current = open;
    setChatMenu(open);
  });
  const onAnswer = useEvent(answer);
  const onEditorHover = useEvent((text: string, line: number, col: number) => (lspEnabled && openFile ? lsp.hover(openFile, text, line, col) : Promise.resolve(null)));
  /**
   * Go to definition (Ctrl+G, Ctrl/Alt+click, right-click): the language server's answer when there is one,
   * otherwise Nou's own (an imported name goes to its import line; a click on an import's path opens it).
   */
  const goToDefinition = async (text: string, line: number, col: number, inEditor: boolean) => {
    if (!openFile) return;
    const file = openFile;
    const target = (lspEnabled ? await lsp.definition(file, text, line, col).catch(() => null) : null) ?? findDefinition(file, text, line, col);
    if (!target) {
      const word = wordAt(text.split(/\r?\n/)[line - 1] ?? "", col)?.word;
      return info(word ? `No definition found for ${word}.` : "Ctrl+click (or Option+click, or right-click) a name to go to its definition.");
    }
    // Keep unsaved text when jumping within the same file.
    if (inEditor && target.file === file && draft.current) draft.current = { ...draft.current, text };
    if (inEditor) openAt(target.file, target.line, true);
    else openAt(target.file, target.line, false, target.line);
  };
  const onEditorDefinition = useEvent((text: string, line: number, col: number) => void goToDefinition(text, line, col, true));
  const onCodeDefine = useEvent((line: number, col: number) => void goToDefinition(content, line, col, false));
  const onEditorSave = useEvent((text: string) => saveFromEditor(text));
  const onEditorExit = useEvent(() => {
    draft.current = null;
    editorStateRef.current = null;
    setEditing(false);
  });
  const onEditorState = useEvent((state: EditorState) => {
    if (!openFile) return;
    const prev = editorStateRef.current;
    editorStateRef.current = state;
    if (prev?.line !== state.line || prev?.dirty !== state.dirty || prev?.selection !== state.selection) {
      setEditorState({ line: state.line, dirty: state.dirty, selection: state.selection });
    }
    draft.current = state.dirty
      ? { path: openFile, text: state.lines.join("\n"), baseline: draft.current?.path === openFile ? draft.current.baseline : content }
      : null;
    // Live problems while you type (debounced).
    if (prev && prev.lines !== state.lines) {
      if (editorProblemsTimer.current) clearTimeout(editorProblemsTimer.current);
      const file = openFile;
      editorProblemsTimer.current = setTimeout(() => void diagnostics.checkFile(file, state.lines.join("\n")), 700);
    }
  });
  const lspEnabled = activePlugins.some((p) => p.id === "lsp");

  if (view === "settings") {
    return (
      <Settings
        width={columns}
        height={rows}
        settings={settings}
        choice={choice}
        plugins={allPlugins}
        {...(connectTo ? { connectTo } : {})}
        reason={setupReason}
        onModel={(next) => void chooseModel(next)}
        onEngine={(id) => void switchEngine(id)}
        onChange={updateSettings}
        onTogglePlugin={(id, enabled) => void togglePlugin(id, enabled)}
        onRescanPlugins={rescanPlugins}
        onClose={() => {
          setConnectTo(undefined);
          setSetupReason(null);
          setView("main");
        }}
      />
    );
  }

  const height = Math.max(10, rows - 2);
  const treeWidth = paneWidths ? Math.max(MIN_TREE, Math.round(columns * paneWidths.tree)) : Math.max(24, Math.floor(columns * 0.2));
  const chatWidth = paneWidths ? Math.max(MIN_CHAT, Math.min(Math.round(columns * paneWidths.chat), columns - treeWidth - MIN_CODE)) : Math.max(34, Math.floor(columns * 0.3));
  const codeWidth = Math.max(MIN_CODE, columns - treeWidth - chatWidth);
  const tabStrip = tabs.length >= 2 && openFile ? <Tabs tabs={tabs} active={openFile} width={tabsWidth(codeWidth)} dirty={showEditor && !!editorState?.dirty} /> : undefined;
  layout.current = { treeWidth, codeWidth, paneHeight: height };
  const wheelFor = (pane: Focus) => (wheel?.pane === pane ? wheel : null);
  const scrollFor = (pane: Focus) => (scrollTo?.pane === pane ? scrollTo : null);
  const totals = diagnostics.counts();
  const checking = diagnostics.busy;

  /** Starts a command in the chat's input, for commands that need something typed after them. */
  const typeCommand = (text: string) => {
    setFocus("chat");
    setChatPrefill((p) => ({ text, nonce: (p?.nonce ?? 0) + 1 }));
  };
  const toggleMouse = () => {
    updateSettings({ mouse: !settings.mouse });
    info(settings.mouse ? "Mouse off: drag to select text and copy it as usual in your terminal. m turns it back on." : "Mouse on: wheel scrolls, click focuses, drag borders to resize.");
  };
  /** Back to the file that was open before this one. */
  const goBack = () => {
    const previous = recent.find((f) => f !== openFile);
    if (!previous) return info("No earlier file to go back to yet: Ctrl+P lists the files you've opened.");
    open(previous);
    setReveal(previous);
  };
  const toggleProblems = () => {
    setCodePanel((p) => (p === "problems" ? "code" : "problems"));
    setEditing(false);
    setFocus("code");
  };
  // Everything Nou can do, for the command palette (? or Ctrl+P then >), with the key that does it.
  const paletteActions: PaletteAction[] = [
    { title: "Find a file", keys: "Ctrl+P", run: () => setQuickOpen("") },
    { title: "Find in the open file", keys: "Ctrl+F", run: startFind },
    { title: "Open a file at a line", keys: "/open", run: () => typeCommand("/open ") },
    { title: "Go back to the previous file", keys: "b", run: goBack },
    { title: "Next tab", keys: "]", run: () => cycleTab(1) },
    { title: "Previous tab", keys: "[", run: () => cycleTab(-1) },
    { title: "Close the tab", keys: "x", run: () => closeTab() },
    { title: "Edit the open file", keys: "e · double-click", run: startEditing },
    { title: "Diff the open file (vs git, Nou's edit, this session)", keys: "v", run: cycleDiff },
    { title: "Undo Nou's last change", keys: "u", run: undoLast },
    { title: "Rewind everything from Nou's last turn", keys: "/rewind", run: rewind },
    { title: "Changes this session", keys: "/diff", run: () => showSessionDiff("") },
    { title: "Earlier sessions", keys: "/sessions", run: showSessions },
    { title: "Recent changes", keys: "/history", run: showHistory },
    { title: "Problems: every error and warning", keys: "p", run: toggleProblems },
    { title: "Switch model", keys: "/model", run: () => setView("settings") },
    { title: "Connect a provider (API key)", keys: "/connect", run: () => typeCommand("/connect ") },
    { title: "Switch engine (Nou, Claude Code, Codex, pi)", keys: "/engine", run: () => void runCommand("/engine") },
    { title: "Ask before every edit and command", keys: "Shift+Tab", run: () => cycleAutoMode("ask") },
    { title: "Auto-edit: apply edits without asking", keys: "Shift+Tab", run: () => cycleAutoMode("auto-edit") },
    { title: "Auto: edits and commands without asking", keys: "Shift+Tab", run: () => cycleAutoMode("auto") },
    { title: `Follow mode ${follow ? "off" : "on"}: jump to files Nou works on`, keys: "f", run: () => setFollow((f) => !f) },
    { title: `Replay speed for follow mode: ${settings.followSpeed} (next: ${FOLLOW_SPEEDS[(FOLLOW_SPEEDS.indexOf(settings.followSpeed) + 1) % FOLLOW_SPEEDS.length]})`, keys: "settings", run: () => updateSettings({ followSpeed: FOLLOW_SPEEDS[(FOLLOW_SPEEDS.indexOf(settings.followSpeed) + 1) % FOLLOW_SPEEDS.length]! }) },
    { title: `Mouse ${settings.mouse ? "off (select text in the terminal)" : "on"}`, keys: "m", run: toggleMouse },
    { title: "Copy the last reply", keys: "/copy", run: () => void runCommand("/copy") },
    { title: "Copy the last code block", keys: "/copy code", run: () => void runCommand("/copy code") },
    { title: "Copy the open file", keys: "/copy file", run: () => void runCommand("/copy file") },
    { title: "Summarize the conversation to free up context", keys: "/compact", run: () => void runCommand("/compact") },
    { title: "Start a fresh conversation", keys: "/clear", run: () => void runCommand("/clear") },
    { title: "Download an Ollama model", keys: "/pull", run: () => typeCommand("/pull ") },
    { title: "Plugins", keys: "/plugins", run: () => void runCommand("/plugins") },
    { title: "Settings: model, engine, preferences, plugins", keys: "s", run: () => setView("settings") },
    { title: "Reset the pane widths", keys: "=", run: () => {
      setPaneWidths(null);
      updateSettings({ paneWidths: null });
    } },
    { title: "Go to the chat", keys: "Tab · Esc", run: () => setFocus("chat") },
    { title: "Go to the files", keys: "Tab", run: () => setFocus("tree") },
    { title: "Go to the code", keys: "Tab", run: () => setFocus("code") },
    { title: "All commands and keys", keys: "/help", run: () => void runCommand("/help") },
    ...pluginCommands.map((c) => ({ title: `${c.description}`, keys: `/${c.name}`, run: () => typeCommand(`/${c.name} `) })),
    { title: "Quit Nou", keys: "Ctrl+C ×2", run: quit },
  ];

  const mode = resizing
    ? { label: "RESIZE", color: C.cyan }
    : approval
      ? { label: "APPROVE", color: C.yellow }
      : showEditor ? { label: "EDIT", color: C.green }
        : diff ? { label: "DIFF", color: C.accent2 }
          : busy ? { label: "WORKING", color: C.accent2 }
            : { label: focus.toUpperCase(), color: C.accent };

  // Shortcuts for the status bar, most useful first; the ones that don't fit are left out (all of them are in /help).
  const hints: [string, string][] = resizing
    ? [[`files ${treeWidth} · code ${codeWidth} · chat ${chatWidth}`, "columns"], ["release", "to keep it"], ["=", "reset"]]
    : approval && !(showEditor && focus === "code")
      ? [["y", "accept"], ["n", "reject"], ...(pendingChange && diff !== pendingChange ? [["o", "show the edit"] as [string, string]] : []), ["Esc", "stop"], ["Shift+Tab", "auto mode"]]
      : showEditor && focus === "code"
        ? editorState?.selection
          ? [["Ctrl+C", "copy"], ["Ctrl+X", "cut"], ["Tab", "indent"], ["Ctrl+/", "comment"], ["Esc", "deselect"]]
          : [["Esc", "done"], ["Ctrl+S", settings.autoSave === "off" ? "save" : "save (auto-save on)"], ["Ctrl+Z", "undo"], ["Shift+→", "select"], ["Ctrl+F", "find"], ["Ctrl+/", "comment"], ["/help", "all keys"]]
        : focus === "chat"
          ? chatMenu ? [["↑↓", "choose"], ["Tab", "complete"], ["Enter", "run"], ["Esc", "close"]]
            : busy
              ? [["Esc", "stop"], ["Shift+↑↓", "scroll"], ["Tab", "next pane"]]
              : [["Enter", "send"], ["/", "commands"], ["Tab", "next pane"], ["Ctrl+P", "find file"], ["Shift+↑↓", "scroll"]]
          : focus === "tree"
            ? [["Enter", "open"], ["e", "edit"], ["/", "command"], ["c", "changes"], ["Ctrl+P", "find"], ["u", "undo"], ["p", "problems"], ["< >", "resize"], ["m", "select text"], ["s", "settings"]]
            : diff
              ? [["Esc", "close diff"], ["n/N", "next/prev change"], ...(diffMode === "session" ? [["[ ]", "prev/next file"] as [string, string]] : []), ["v", "cycle diff"]]
              : [["double-click/e", "edit"], ["Ctrl+F", "find"], ["v", "diff"], ...(recent.length > 1 ? [["b", "back"] as [string, string]] : []), ["u", "undo"], ["/", "command"], ["p", "problems"], ["< >", "resize"], ["m", "select text"], ["s", "settings"]];
  const followChip = follow ? ` ◉ follow${followLag ? ` ·${followLag}` : ""} ` : " ○ follow ";
  const statusUsed = mode.label.length + 2 + autoMode.length + 2 + followChip.length + ` ✖ ${totals.errors} ▲ ${totals.warnings} `.length + (checking.length ? 4 + checking.join(", ").length : 0) + 2;
  const shownHints: [string, string][] = [];
  for (let used = statusUsed, i = 0; i < hints.length; i++) {
    used += hints[i]![0].length + hints[i]![1].length + 4;
    if (used > columns) break;
    shownHints.push(hints[i]!);
  }

  // The status bar and the header can be clicked: what each part shows, it does.
  const hintAction: Record<string, (() => void) | undefined> = {
    y: () => answer(true), n: approval ? () => answer(false) : undefined, o: openPending,
    "Shift+Tab": () => cycleAutoMode(), "/": () => typeCommand("/"), "Ctrl+P": () => setQuickOpen(""),
    Tab: () => setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + 1) % FOCUS_ORDER.length]!),
    e: startEditing, "double-click/e": startEditing, b: goBack, "Ctrl+F": showEditor ? undefined : startFind, v: cycleDiff, u: undoLast, p: toggleProblems, m: toggleMouse,
    s: () => setView("settings"), "/help": () => void runCommand("/help"),
    Esc: busy ? stop : diff && !showEditor ? () => setDiffMode("off") : undefined,
  };
  const zones: StatusZone[] = [];
  {
    let x = ` ${mode.label} `.length;
    const add = (width: number, run?: () => void) => {
      if (run) zones.push({ from: x, to: x + width, run });
      x += width;
    };
    add(` ${autoMode} `.length, () => cycleAutoMode());
    add(followChip.length, () => setFollow((f) => !f));
    add(` ✖ ${totals.errors} ▲ ${totals.warnings} `.length, toggleProblems);
    if (checking.length) add(3 + checking.join(", ").length);
    if (!exitArmed) {
      shownHints.forEach(([key, label], i) => {
        add(i === 0 ? 2 : 3);
        add(key.length + 1 + label.length, hintAction[key]);
      });
    }
  }
  const modelLabel = agentRef.current!.id === "nou" ? describe(choice) : `${engineInfo(agentRef.current!.id).label} · ${engineInfo(agentRef.current!.id).model(choice)}`;
  clickable.current = { status: zones, modelFrom: columns - (" ⌂ LOCAL ".length + ` ${modelLabel} `.length + 1) };

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header width={columns} branch={branch} changes={git.size} model={modelLabel} local={choice.provider.local} busy={busy} update={update} />
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
          problemCounts={problemCounts}
          wheel={wheelFor("tree")}
          scrollTo={scrollFor("tree")}
          click={treeClick}
          onOpen={onTreeOpen}
          onHover={onTreeHover}
        />
        {codePanel === "problems" && !pendingChange ? (
          <ProblemsView
            width={codeWidth}
            height={height}
            focused={focus === "code"}
            problems={diagnostics.all()}
            checking={checking}
            wheel={wheelFor("code")}
            onJump={onJump}
            onClose={onCloseProblems}
          />
        ) : showEditor ? (
          <Editor
            key={`${openFile}:${editorStart.nonce}`}
            {...(tabStrip ? { tabs: tabStrip } : {})}
            width={codeWidth}
            height={height}
            focused={focus === "code"}
            filePath={openFile}
            initial={draft.current?.path === openFile ? draft.current.text : content}
            baseline={draft.current?.path === openFile ? draft.current.baseline : content}
            startLine={editorStart.line}
            {...(editorStart.col ? { startCol: editorStart.col } : {})}
            problems={fileProblems}
            autoSave={settings.autoSave}
            syntaxVersion={syntaxVersion}
            wheel={wheelFor("code")}
            scrollTo={scrollFor("code")}
            mouse={editorMouse}
            onHover={onEditorHover}
            onDefinition={onEditorDefinition}
            onSave={onEditorSave}
            onExit={onEditorExit}
            onState={onEditorState}
          />
        ) : (
          <CodeView
            {...(tabStrip && !diff ? { tabs: tabStrip } : {})}
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
            scrollTo={scrollFor("code")}
            onViewport={onViewport}
            defineAt={codeDefine}
            onDefine={onCodeDefine}
            onFinding={onCodeFinding}
            findRequest={findRequest}
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
          scrollTo={scrollFor("chat")}
          prefill={chatPrefill}
          extraCommands={pluginCommands}
          onMenu={onChatMenu}
          onSubmit={onSend}
          queued={queued}
          onAnswer={onAnswer}
          click={chatClick}
          onOpenRef={openRef}
        />
      </Box>
      <Box>
        <Text wrap="truncate-end">
          <Text backgroundColor={mode.color} color="black" bold>{` ${mode.label} `}</Text>
          <Text backgroundColor={C.panel} color={autoMode === "ask" ? C.dim : C.orange} bold={autoMode !== "ask"}>{` ${autoMode === "ask" ? "ask" : autoMode} `}</Text>
          <Text backgroundColor={C.panel} color={follow ? C.green : C.dim}>{followChip}</Text>
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
      {quickOpen !== null && (
        <QuickOpen
          width={columns}
          top={3}
          files={allFiles}
          recent={recent}
          actions={paletteActions}
          initialQuery={quickOpen}
          onPick={(file) => {
            setQuickOpen(null);
            open(file);
            setReveal(file);
            setFocus("code");
          }}
          onRun={(action) => {
            setQuickOpen(null);
            action.run();
          }}
          onClose={() => setQuickOpen(null)}
        />
      )}
    </Box>
  );
}
