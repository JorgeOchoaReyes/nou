import { useCallback, useEffect, useRef, useState } from "react";
import { readFileSync } from "fs";
import path from "path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Agent, type ApprovalRequest, type ChangeStatus, type ChatEntry } from "../agent/index.js";
import { describe, providers, resolveModel, saveModel, type ModelChoice } from "../providers/index.js";
import type { FileChange } from "../commands/index.js";
import { changedLines } from "./text.js";
import { FileTree } from "./FileTree.js";
import { CodeView } from "./CodeView.js";
import { Chat } from "./Chat.js";

type Focus = "tree" | "code" | "chat";
const FOCUS_ORDER: Focus[] = ["tree", "code", "chat"];
const NO_LINES = new Set<number>();

type Props = { initialModel: ModelChoice; systemPrompt: string };

const HELP = `Commands:
  /model               show providers and the current model
  /model <provider[:model]>  switch, e.g. /model anthropic  /model ollama:qwen3:8b  /model lmstudio:my-model
  /models [provider]   list models a provider offers
  /clear               start a fresh conversation
  Esc                  cancel what Nou is doing`;

function readText(filePath: string): string {
  try {
    return readFileSync(path.resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return "";
  }
}

export function App({ initialModel, systemPrompt }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();

  const [focus, setFocus] = useState<Focus>("chat");
  const [follow, setFollow] = useState(true);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState(initialModel);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve(ok: boolean): void } | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  // The last change per file, so we can flag edited lines and re-open the diff.
  const [changes, setChanges] = useState<Map<string, { change: FileChange; status: ChangeStatus; lines: Set<number> }>>(new Map());
  const [showDiff, setShowDiff] = useState(false);

  const followRef = useRef(follow);
  followRef.current = follow;

  const open = useCallback((filePath: string) => {
    setOpenFile(filePath);
    setContent(readText(filePath));
    setShowDiff(false);
  }, []);

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    agentRef.current = new Agent(initialModel, systemPrompt, {
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
          setShowDiff(status === "pending");
          setReveal(change.path);
        }
        if (status === "applied") setTreeVersion((v) => v + 1);
      },
      approve: (request) => new Promise<boolean>((resolve) => setApproval({ request, resolve })),
    });
  }

  // Keep the viewer in sync if the open file changes on disk via a command.
  useEffect(() => {
    if (!busy && openFile && !showDiff) setContent(readText(openFile));
  }, [busy]);

  const answer = (ok: boolean) => {
    approval?.resolve(ok);
    setApproval(null);
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
    if (key.tab) {
      const step = key.shift ? -1 : 1;
      setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + step + FOCUS_ORDER.length) % FOCUS_ORDER.length]!);
      return;
    }
    if (key.escape) {
      if (busy) agentRef.current?.cancel();
      setFocus("chat");
      return;
    }
    if (focus === "chat") return; // letters belong to the text box
    if (input === "f") setFollow((f) => !f);
    else if (input === "v" && openFile && changes.has(openFile)) setShowDiff((s) => !s);
    else if (input === "q") exit();
  });

  const info = (text: string, kind: ChatEntry["kind"] = "info") => setEntries((prev) => [...prev, { kind, text }]);

  const runCommand = async (input: string) => {
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (command) {
    case "model": {
      if (!arg) {
        const rows = providers.map((p) => {
          const problem = p.unavailable();
          return `${p.id === choice.provider.id ? "▸" : " "} ${p.id.padEnd(10)} ${p.local ? "local " : "cloud "} ${problem ? `(${problem})` : `default ${p.defaultModel}`}`;
        });
        info(`Current: ${describe(choice)}\n${rows.join("\n")}\nSwitch with /model <provider[:model]>`);
        return;
      }
      const next = resolveModel(arg);
      const problem = next.provider.unavailable();
      if (problem) return info(`${next.provider.label} isn't set up: ${problem}`, "error");
      agentRef.current!.setModel(next);
      setChoice(next);
      saveModel(next);
      return info(`Now using ${describe(next)} (${next.provider.label}). The conversation carries over.`);
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
    default:
      return info(`Unknown command /${command}. Type /help.`, "error");
    }
  };

  const send = (text: string) => {
    if (text.startsWith("/")) {
      void runCommand(text);
      return;
    }
    setEntries((prev) => [...prev, { kind: "user", text }]);
    void agentRef.current!.send(text);
  };

  const record = openFile ? changes.get(openFile) : undefined;
  const pending = approval?.request.kind === "change";
  const diff = pending && approval.request.kind === "change"
    ? approval.request.change
    : showDiff && record ? record.change : null;

  const height = Math.max(10, rows - 1);
  const treeWidth = Math.max(22, Math.floor(columns * 0.18));
  const chatWidth = Math.max(32, Math.floor(columns * 0.3));
  const codeWidth = Math.max(20, columns - treeWidth - chatWidth);
  const edited = new Set([...changes].filter(([, c]) => c.status === "applied").map(([p]) => p));

  const hints = approval
    ? "y accept · n reject · Esc stop"
    : focus === "chat"
      ? busy ? "Esc cancel · Tab switch pane · Ctrl+C quit" : "Enter send · /help commands · PgUp/PgDn scroll · Tab switch pane · Ctrl+C quit"
      : focus === "tree"
        ? "↑↓ move · Enter/→ open · ← collapse · f follow · Tab switch · q quit"
        : `↑↓/PgUp/PgDn scroll · g/G top/end${record ? " · v toggle diff" : ""} · f follow · Tab switch · q quit`;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" height={height}>
        <FileTree
          width={treeWidth}
          height={height}
          focused={focus === "tree" && !approval}
          openFile={openFile}
          reveal={reveal}
          version={treeVersion}
          changed={edited}
          onOpen={(filePath) => {
            open(filePath);
            setFocus("code");
          }}
        />
        <CodeView
          width={codeWidth}
          height={height}
          focused={focus === "code" && !approval}
          filePath={openFile}
          content={content}
          diff={diff}
          pending={pending}
          marked={record?.lines ?? NO_LINES}
        />
        <Chat
          width={chatWidth}
          height={height}
          focused={focus === "chat"}
          entries={entries}
          streaming={streaming}
          busy={busy}
          approval={approval?.request ?? null}
          onSubmit={send}
        />
      </Box>
      <Box>
        <Text color="gray" wrap="truncate-end">
          {" "}<Text color={follow ? "green" : "gray"}>{follow ? "● follow" : "○ follow"}</Text>
          {"  "}<Text color={choice.provider.local ? "green" : "magenta"}>{describe(choice)}</Text>{"  │  "}{hints}
        </Text>
      </Box>
    </Box>
  );
}
