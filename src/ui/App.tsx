import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Agent, buildSystemPrompt, type ApprovalRequest, type ChangeStatus, type ChatEntry, type ExtraTool } from "../agent/index.js";
import { describe, providers, resolveModel, saveModel, type ModelChoice } from "../providers/index.js";
import type { FileChange } from "../commands/index.js";
import { loadSettings, saveSettings, type Settings as SettingsType } from "../config/index.js";
import { branch as gitBranch, diffAgainstHead, isRepo, status as gitStatus, summary as gitSummary, type GitStatus } from "../git/index.js";
import { gitTools } from "../git/tools.js";
import { discoverPlugins, loadPlugin, type PluginEntry } from "../plugins/index.js";
import { changedLines } from "./text.js";
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
Keys:
  Ctrl+P  find a file      Tab  switch pane      Esc  stop / back
  e  edit open file        v    diff (git / Nou)  f   follow mode
  c  (in files) show only changed files            s   settings`;

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
      onChange: (change, status) => {
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
    });
  }

  // Discover plugins once and load the enabled ones.
  useEffect(() => {
    void (async () => {
      const found = discoverPlugins();
      const enabled = loadSettings().plugins;
      setPlugins(await Promise.all(found.map((p) => (enabled[p.id] ? loadPlugin(p) : p))));
    })();
  }, []);

  const activePlugins = useMemo(() => plugins.filter((p) => settings.plugins[p.id] && p.plugin), [plugins, settings.plugins]);

  // Keep the agent's system prompt and tools in sync with settings and plugins.
  useEffect(() => {
    const extras: string[] = [];
    const extraTools: ExtraTool[] = [];
    if (settings.gitContext && repo) {
      const summary = gitSummary();
      if (summary) extras.push(summary);
      extraTools.push(...gitTools());
    }
    for (const { plugin } of activePlugins) {
      if (plugin!.systemPrompt) extras.push(`Plugin ${plugin!.name}: ${plugin!.systemPrompt}`);
      for (const tool of plugin!.tools ?? []) {
        extraTools.push({
          definition: tool.definition,
          readOnly: !!tool.readOnly,
          source: plugin!.name,
          run: (args) => tool.run(args, { cwd: process.cwd() }),
        });
      }
    }
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
    updateSettings({ plugins: { ...settings.plugins, [id]: enabled } });
    if (!enabled) return;
    const entry = plugins.find((p) => p.id === id);
    if (entry && !entry.plugin) {
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

  const startEditing = () => {
    if (!openFile) return;
    if (draft.current && draft.current.path !== openFile) draft.current = null;
    setDiffMode("off");
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
    else if (input === "v") cycleDiff();
    else if (input === "e") startEditing();
    else if (input === "s" || input === ",") setView("settings");
    else if (input === "r") {
      refreshGit();
      setTreeVersion((v) => v + 1);
    } else if (input === "q") exit();
  }, { isActive: view === "main" && !quickOpen });

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
    const info = (text: string, kind: ChatEntry["kind"] = "info") => setEntries((prev) => [...prev, { kind, text }]);
    switch (command) {
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

  const saveFromEditor = (text: string) => {
    if (!openFile) return;
    try {
      writeFileSync(path.resolve(process.cwd(), openFile), text, "utf-8");
      setContent(text);
      draft.current = null;
      setTreeVersion((v) => v + 1);
      refreshGit();
    } catch (error: any) {
      setEntries((prev) => [...prev, { kind: "error", text: `Couldn't save ${openFile}: ${error.message}` }]);
    }
  };

  if (view === "settings") {
    return (
      <Settings
        width={columns}
        height={rows}
        settings={settings}
        choice={choice}
        plugins={plugins}
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
  const edited = new Set([...changes].filter(([, c]) => c.status === "applied").map(([p]) => p));

  const mode = approval
    ? { label: "APPROVE", color: C.yellow }
    : showEditor ? { label: "EDIT", color: C.green }
      : diff ? { label: "DIFF", color: C.accent2 }
        : busy ? { label: "WORKING", color: C.accent2 }
          : { label: focus.toUpperCase(), color: C.accent };

  const hints = approval
    ? "y accept · n reject · Esc stop"
    : showEditor && focus === "code"
      ? "Ctrl+S save · Ctrl+Z undo · Esc close editor · Ctrl+P find file"
      : focus === "chat"
        ? busy ? "Esc stop · Tab switch pane" : "Enter send · / commands · Ctrl+P find file · Tab switch pane"
        : focus === "tree"
          ? "↑↓ move · Enter open · c changes · e edit · Ctrl+P find · s settings · q quit"
          : diff ? "n/N next/prev change · v cycle diff · Esc close diff" : "↑↓ scroll · e edit · v diff · f follow · s settings · q quit";

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header width={columns} branch={branch} changes={git.size} model={describe(choice)} local={choice.provider.local} busy={busy} />
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
          onOpen={(filePath) => {
            open(filePath);
            setFocus("code");
          }}
          onHover={() => {}}
        />
        {showEditor ? (
          <Editor
            key={openFile}
            width={codeWidth}
            height={height}
            focused={focus === "code"}
            filePath={openFile}
            initial={draft.current?.path === openFile ? draft.current.text : content}
            baseline={draft.current?.path === openFile ? draft.current.baseline : content}
            onSave={saveFromEditor}
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
          contextChip={contextChip}
          onSubmit={send}
        />
      </Box>
      <Box>
        <Text wrap="truncate-end">
          <Text backgroundColor={mode.color} color="black" bold>{` ${mode.label} `}</Text>
          <Text backgroundColor={C.panel} color={follow ? C.green : C.dim}>{follow ? " ◉ follow " : " ○ follow "}</Text>
          <Text color={C.dim}>{"  "}{hints}</Text>
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
