import { useEffect, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import TextInput from "ink-text-input";
import { AUTO_SAVE, CODE_THEMES, EFFORTS, FOLLOW_SPEEDS, type Settings as SettingsType } from "../config/index.js";
import { highlightLines } from "./text.js";
import { GAMES } from "../games/index.js";
import { saveCredentials } from "../config/credentials.js";
import { originOf, setOutsideNou } from "../config/origins.js";
import { PLUGIN_DIRS, isEnabled, trustState, type PluginEntry } from "../plugins/index.js";
import { currentVersion } from "../update/index.js";
import { describe, providers, rejectedKey, type ModelChoice, type Provider } from "../providers/index.js";
import { ENGINES, isInstalled, type EngineId } from "../engines/index.js";
import { C, SPINNER, ANIMATION_MS } from "./theme.js";

type Props = {
  width: number;
  height: number;
  settings: SettingsType;
  choice: ModelChoice;
  plugins: PluginEntry[];
  /** Open on this provider's connect form (the /connect command). */
  connectTo?: Provider;
  /** Why settings opened, e.g. the error a request just hit, shown above the form. */
  reason?: string | null;
  onModel(choice: ModelChoice): void;
  onEngine(id: EngineId): void;
  onChange(patch: Partial<SettingsType>): void;
  onTogglePlugin(id: string, enabled: boolean): void;
  onRescanPlugins(): void;
  onClose(): void;
};

/** A few lines of code to show what a code theme looks like. */
const THEME_PREVIEW = `// Greets someone, politely
export function greet(name: string, times = 2): string {
  return \`Hello \${name}!\`.repeat(times) || null;
}`;

const TABS = ["Model", "Engine", "Preferences", "Plugins", "Games"] as const;
type Tab = (typeof TABS)[number];

type Pref = { key: keyof SettingsType; label: string; help: string; warn?: boolean };
const PREFS: Pref[] = [
  { key: "effort", label: "Reasoning effort", help: "How hard Claude thinks (low → max). Higher is smarter but slower and pricier." },
  { key: "followSpeed", label: "Follow mode speed", help: "How long each file Nou reads stays on screen in follow mode (f): slow, normal, fast, or as it happens." },
  { key: "codeTheme", label: "Code colors", help: "The theme for code. ←/→ to try them; github-light is for light terminals." },
  { key: "autoSave", label: "Auto-save", help: "delay: a second after you stop typing · focus: when you leave the editor · off: only Ctrl+S." },
  { key: "mouse", label: "Mouse", help: "Wheel scrolls the pane under the pointer; click to focus or open files. Hold Shift to select text." },
  { key: "followMode", label: "Follow mode on start", help: "The code view jumps to files Nou reads and edits." },
  { key: "reuseToolConfig", label: "Use Claude Code / Codex keys", help: "Use the API keys from Claude Code's or Codex's settings when you haven't set one. Applies on restart." },
  { key: "gitContext", label: "Git context", help: "Give the model your branch, changes and commits, plus git tools." },
  { key: "autoApproveEdits", label: "Auto-approve edits", help: "Apply file edits without asking (diffs are still shown).", warn: true },
  { key: "autoApproveCommands", label: "Auto-approve commands", help: "Run shell commands without asking. Only turn on if you trust the model.", warn: true },
];

/** Where you are in a provider's connect form: which field, and what's been entered so far. */
type Connecting = { step: number; values: Record<string, string> };

export function Settings({ width, height, settings, choice, plugins, connectTo, reason, onModel, onEngine, onChange, onTogglePlugin, onRescanPlugins, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("Model");
  const [row, setRow] = useState(() => Math.max(0, providers.indexOf(connectTo ?? choice.provider)));
  const [column, setColumn] = useState<"providers" | "models">("providers");
  const [modelRow, setModelRow] = useState(0);
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const [models, setModels] = useState<Record<string, string[] | { error: string } | "loading">>({});
  const [connecting, setConnecting] = useState<Connecting | null>(connectTo?.connect ? { step: 0, values: {} } : null);
  const [field, setField] = useState(() => (connectTo?.connect ? initialValue(connectTo.connect[0]!) : ""));
  const { frame } = useAnimation({ interval: ANIMATION_MS });

  const provider = providers[row] ?? providers[0]!;
  const listed = models[provider.id];

  // Load the model list for the highlighted provider.
  useEffect(() => {
    if (tab !== "Model" || connecting || provider.unavailable() || models[provider.id]) return;
    setModels((m) => ({ ...m, [provider.id]: "loading" }));
    provider.listModels()
      .then((list) => setModels((m) => ({ ...m, [provider.id]: list })))
      .catch((error) => setModels((m) => ({ ...m, [provider.id]: { error: String(error.message ?? error) } })));
  }, [tab, provider.id, connecting]);

  const startConnect = () => {
    if (!provider.connect) return;
    setConnecting({ step: 0, values: {} });
    setField(initialValue(provider.connect[0]!));
  };

  /** Takes the current field's answer; after the last one, saves everything and shows the provider's models. */
  const submitField = (value: string) => {
    const fields = provider.connect!;
    const current = fields[connecting!.step]!;
    // Required, and nothing set yet: ask again.
    if (!value.trim() && !current.optional && !process.env[current.env]) return;
    const values = { ...connecting!.values, [current.env]: value };
    const next = connecting!.step + 1;
    if (next < fields.length) {
      setConnecting({ step: next, values });
      setField(initialValue(fields[next]!));
      return;
    }
    saveCredentials(values);
    setConnecting(null);
    setModels((m) => Object.fromEntries(Object.entries(m).filter(([id]) => id !== provider.id)));
    if (!provider.unavailable()) {
      setColumn("models");
      setModelRow(0);
    }
  };

  const modelItems = Array.isArray(listed) ? listed : [];
  const rowsFor = (t: Tab) => (t === "Model" ? providers.length : t === "Engine" ? ENGINES.length : t === "Preferences" ? PREFS.length : t === "Games" ? GAMES.length : plugins.length);

  useInput((input, key) => {
    if (connecting) {
      if (key.escape) setConnecting(null);
      return;
    }
    if (typing) {
      if (key.escape) setTyping(false);
      return;
    }
    if (key.tab) {
      const next = TABS[(TABS.indexOf(tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]!;
      setTab(next);
      setRow(next === "Model" ? Math.max(0, providers.indexOf(choice.provider)) : next === "Engine" ? Math.max(0, ENGINES.findIndex((e) => e.id === settings.engine)) : 0);
      setColumn("providers");
      return;
    }
    if (key.escape) {
      if (tab === "Model" && column === "models") setColumn("providers");
      else onClose();
      return;
    }

    if (tab === "Model" && column === "models") {
      const count = modelItems.length + 1;
      if (key.upArrow) setModelRow((r) => Math.max(0, r - 1));
      else if (key.downArrow) setModelRow((r) => Math.min(count - 1, r + 1));
      else if (key.leftArrow) setColumn("providers");
      else if (input === "k") startConnect();
      else if (key.return) {
        if (modelRow === 0) {
          setCustom("");
          setTyping(true);
        } else onModel({ provider, model: modelItems[modelRow - 1]! });
      }
      return;
    }

    if (key.upArrow) setRow((r) => Math.max(0, r - 1));
    else if (key.downArrow) setRow((r) => Math.min(rowsFor(tab) - 1, r + 1));
    else if (tab === "Model" && (key.return || key.rightArrow)) {
      if (!provider.unavailable()) {
        setColumn("models");
        setModelRow(0);
      } else startConnect();
    } else if (tab === "Model" && input === "k") {
      startConnect();
    } else if (tab === "Engine" && (key.return || input === " ")) {
      onEngine(ENGINES[row]!.id);
    } else if (tab === "Preferences" && (key.return || input === " " || key.leftArrow || key.rightArrow)) {
      const pref = PREFS[row]!;
      const step = key.leftArrow ? -1 : 1;
      if (pref.key === "effort") {
        onChange({ effort: EFFORTS[(EFFORTS.indexOf(settings.effort) + step + EFFORTS.length) % EFFORTS.length]! });
      } else if (pref.key === "followSpeed") {
        onChange({ followSpeed: FOLLOW_SPEEDS[(FOLLOW_SPEEDS.indexOf(settings.followSpeed) + step + FOLLOW_SPEEDS.length) % FOLLOW_SPEEDS.length]! });
      } else if (pref.key === "codeTheme") {
        onChange({ codeTheme: CODE_THEMES[(CODE_THEMES.indexOf(settings.codeTheme) + step + CODE_THEMES.length) % CODE_THEMES.length]! });
      } else if (pref.key === "autoSave") {
        onChange({ autoSave: AUTO_SAVE[(AUTO_SAVE.indexOf(settings.autoSave) + step + AUTO_SAVE.length) % AUTO_SAVE.length]! });
      } else {
        onChange({ [pref.key]: !settings[pref.key] } as Partial<SettingsType>);
      }
    } else if (tab === "Games" && (key.return || input === " ") && GAMES[row]) {
      const id = GAMES[row].id;
      onChange({ games: settings.games.includes(id) ? settings.games.filter((g) => g !== id) : [...settings.games, id] });
    } else if (tab === "Plugins") {
      if (input === "r") onRescanPlugins();
      else if ((key.return || input === " ") && plugins[row]) onTogglePlugin(plugins[row].id, !isEnabled(plugins[row], settings));
    }
  });

  const boxHeight = height - 6;
  // Preferences take three rows each (label, help, gap), the code theme's preview four more: show the ones
  // around the selected one that fit.
  const prefWindow = (() => {
    const room = Math.max(3, boxHeight - 4);
    const cost = (i: number) => 3 + (tab === "Preferences" && i === row && PREFS[i]?.key === "codeTheme" ? 4 : 0);
    let first = tab === "Preferences" ? row : 0;
    let last = first + 1;
    let used = cost(first);
    while (last < PREFS.length && used + cost(last) <= room) used += cost(last++);
    while (first > 0 && used + cost(first - 1) <= room) used += cost(--first);
    return { first, last };
  })();
  const toggle = (on: boolean, warn?: boolean) => (
    <Text color={on ? (warn ? C.orange : C.green) : C.dim} bold>{on ? "● ON " : "○ OFF"}</Text>
  );

  const body = () => {
    if (tab === "Model") {
      const leftWidth = Math.min(46, Math.floor(width * 0.45));
      // Room for the label next to the marker, "local"/"cloud" and the lock (plus the border).
      const labelWidth = Math.max(10, leftWidth - 14);
      return (
        <Box flexDirection="row" height={boxHeight}>
          <Box flexDirection="column" width={leftWidth} borderStyle="round" borderColor={column === "providers" ? C.accent : C.dim}>
            <Text color={C.dim} bold> PROVIDER</Text>
            {providers.map((p, i) => {
              const problem = p.unavailable();
              const selected = i === row;
              const current = p.id === choice.provider.id;
              return (
                <Text key={p.id} wrap="truncate-end" {...(selected && column === "providers" ? { backgroundColor: C.panel } : {})}>
                  <Text color={current ? C.green : C.dim}>{current ? " ● " : "   "}</Text>
                  <Text color={problem ? C.dim : C.text} bold={selected}>{p.label.padEnd(labelWidth).slice(0, labelWidth)}</Text>
                  <Text color={p.local ? C.green : C.accent2}>{p.local ? " local" : " cloud"}</Text>
                  {problem ? <Text color={C.dim}> 🔒</Text> : null}
                </Text>
              );
            })}
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={column === "models" ? C.accent : C.dim} paddingX={1}>
            <Text color={C.dim} bold>MODELS · {provider.label}</Text>
            {reason ? <Text color={C.red} wrap="wrap">✖ {reason}</Text> : null}
            {connecting && provider.connect ? (
              <>
                <Text color={C.accent2} bold>Connect {provider.label}</Text>
                {provider.connect.map((f, i) => {
                  const entered = connecting.values[f.env];
                  const shown = (v: string) => (f.secret ? "•".repeat(Math.min(v.length, 12)) : v);
                  if (i < connecting.step) {
                    return <Text key={f.env} color={C.dim} wrap="truncate-end">✓ {f.label}: {entered ? shown(entered) : "unchanged"}</Text>;
                  }
                  if (i > connecting.step) return <Text key={f.env} color={C.dim}>  {f.label}{f.optional ? " (optional)" : ""}</Text>;
                  return (
                    <Box key={f.env} flexDirection="column">
                      <Text>
                        <Text color={C.accent2}>✎ {f.label}{f.optional ? " (optional)" : ""}: </Text>
                        <TextInput value={field} onChange={setField} onSubmit={submitField} {...(f.secret ? { mask: "•" } : {})} {...(f.placeholder ? { placeholder: f.placeholder } : {})} />
                      </Text>
                      <Text color={C.dim} wrap="truncate-end">
                        {"  "}{f.env}{process.env[f.env] ? (f.secret ? ` is set (from ${originOf(f.env)}); Enter keeps it` : "") : f.optional ? "; Enter skips" : ""}
                      </Text>
                      {setOutsideNou(f.env) && (
                        <Text color={C.yellow} wrap="wrap">  A new one works now, but {originOf(f.env)} sets {f.env} too and wins when Nou restarts: change or remove it there.</Text>
                      )}
                    </Box>
                  );
                })}
                <Text> </Text>
                <Text color={C.dim} wrap="truncate-end">Saved to ~/.nou/credentials.json (only you can read it). Your environment and .env still win.</Text>
              </>
            ) : provider.unavailable() ? (
              <>
                <Text color={C.yellow}>Not set up: {provider.unavailable()}</Text>
                {provider.connect
                  ? <Text color={C.accent2}>Press Enter to connect it: paste your key here, no restart needed.</Text>
                  : null}
                <Text color={C.dim}>Or add it to a .env file in your project (see .env.example) or your environment.</Text>
              </>
            ) : (
              <>
                {typing ? (
                  <Text>
                    <Text color={C.accent2}>✎ </Text>
                    <TextInput
                      value={custom}
                      onChange={setCustom}
                      onSubmit={(v) => {
                        setTyping(false);
                        if (v.trim()) onModel({ provider, model: v.trim() });
                      }}
                      placeholder={`e.g. ${provider.defaultModel}`}
                    />
                  </Text>
                ) : (
                  <Text {...(column === "models" && modelRow === 0 ? { backgroundColor: C.panel } : {})} color={C.accent2}>✎ Type a model name…</Text>
                )}
                {listed === "loading" && <Text color={C.accent2}>{SPINNER[frame % SPINNER.length]} loading models…</Text>}
                {listed && typeof listed === "object" && !Array.isArray(listed) && (
                  <>
                    <Text color={C.red}>Couldn't list models: {listed.error}</Text>
                    {rejectedKey(listed.error) && provider.connect?.some((f) => f.secret) && (() => {
                      const key = provider.connect.find((f) => f.secret)!.env;
                      return <Text color={C.yellow} wrap="wrap">The {key} {originOf(key) ? `from ${originOf(key)} ` : ""}was rejected. Press k to enter a different key.</Text>;
                    })()}
                  </>
                )}
                {(() => {
                  const visibleCount = Math.max(1, boxHeight - 6);
                  const offset = Math.max(0, Math.min(modelRow - 1 - Math.floor(visibleCount / 2), modelItems.length - visibleCount));
                  return modelItems.slice(offset, offset + visibleCount).map((m, i) => {
                    const index = offset + i + 1;
                    const selected = column === "models" && modelRow === index;
                    const current = provider.id === choice.provider.id && m === choice.model;
                    return (
                      <Text key={m} wrap="truncate-end" {...(selected ? { backgroundColor: C.panel } : {})}>
                        <Text color={current ? C.green : C.dim}>{current ? "● " : "  "}</Text>
                        <Text color={selected ? C.text : C.dim} bold={selected}>{m}</Text>
                      </Text>
                    );
                  });
                })()}
              </>
            )}
          </Box>
        </Box>
      );
    }

    if (tab === "Engine") {
      return (
        <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1}>
          {ENGINES.map((engine, i) => {
            const selected = i === row;
            const active = engine.id === settings.engine;
            return (
              <Box key={engine.id} flexDirection="column" marginBottom={1}>
                <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                  <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                  <Text color={active ? C.green : C.dim} bold>{active ? "● " : "○ "}</Text>
                  <Text color={C.text} bold={selected}>{engine.label.padEnd(14)}</Text>
                  <Text color={C.dim}>{active ? "in use · " : ""}model: {engine.model(choice)}</Text>
                </Text>
                {!isInstalled(engine) && <Text color={C.orange} wrap="truncate-end">    Not installed. Enter installs it with npm ({engine.package}) into ~/.nou/engines.</Text>}
                <Text color={C.dim} wrap="truncate-end">    {engine.description}</Text>
                {engine.approvals === "after" && <Text color={C.orange} wrap="truncate-end">    Nou can't ask before its edits; it shows them afterwards so you can undo them.</Text>}
              </Box>
            );
          })}
          <Text color={C.dim} wrap="truncate-end">The engine is the agent that answers in the chat. Diffs, approvals, undo and problems work with each one.</Text>
        </Box>
      );
    }

    if (tab === "Preferences") {
      return (
        <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1} overflow="hidden">
          {prefWindow.first > 0 ? <Text color={C.dim}>  ↑ {prefWindow.first} more</Text> : null}
          {PREFS.slice(prefWindow.first, prefWindow.last).map((pref, at) => {
            const i = prefWindow.first + at;
            const selected = i === row;
            const value = settings[pref.key];
            return (
              <Box key={pref.key} flexDirection="column" marginBottom={1}>
                <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                  <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                  <Text color={C.text} bold={selected}>{pref.label.padEnd(26)}</Text>
                  {pref.key === "codeTheme"
                    ? <Text><Text color={C.dim}>‹ </Text><Text color={C.accent2} bold>{String(value)}</Text><Text color={C.dim}> ›  {CODE_THEMES.indexOf(value as never) + 1}/{CODE_THEMES.length}</Text></Text>
                    : pref.key === "effort" || pref.key === "autoSave" || pref.key === "followSpeed"
                      ? <Text>{(pref.key === "effort" ? EFFORTS : pref.key === "autoSave" ? AUTO_SAVE : FOLLOW_SPEEDS).map((e) => <Text key={e} color={e === value ? C.accent2 : C.dim} bold={e === value}>{e === value ? `[${e}]` : ` ${e} `}</Text>)}</Text>
                      : toggle(value as boolean, pref.warn)}
                </Text>
                <Text color={C.dim} wrap="truncate-end">    {pref.help}</Text>
                {pref.key === "codeTheme" && selected
                  ? highlightLines("preview.ts", THEME_PREVIEW).map((line, n) => <Text key={n} wrap="truncate-end">{"    "}{line}</Text>)
                  : null}
              </Box>
            );
          })}
          {prefWindow.last < PREFS.length ? <Text color={C.dim}>  ↓ {PREFS.length - prefWindow.last} more</Text> : null}
        </Box>
      );
    }

    if (tab === "Games") {
      return (
        <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.dim}>Little games for a break while Nou works. Added ones show in the Games panel: /games, or ? then "games".</Text>
          <Text> </Text>
          {GAMES.map((g, i) => {
            const selected = i === row;
            const added = settings.games.includes(g.id);
            return (
              <Box key={g.id} flexDirection="column" marginBottom={1}>
                <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                  <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                  {added ? <Text color={C.green} bold>✓ ADDED</Text> : <Text color={C.accent2} bold>⬇ GET  </Text>}
                  <Text color={C.text} bold> {g.title}</Text>
                  <Text color={C.dim}>  {g.controls}</Text>
                </Text>
                <Text color={C.dim} wrap="truncate-end">    {g.blurb}</Text>
              </Box>
            );
          })}
        </Box>
      );
    }

    return (
      <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1}>
        {plugins.map((p, i) => {
          const selected = i === row;
          const state = trustState(p, settings);
          const enabled = state === "on";
          const parts = p.plugin
            ? [
              (p.plugin.tools ?? []).length && `${p.plugin.tools!.length} tools`,
              (p.plugin.commands ?? []).length && `${p.plugin.commands!.length} commands`,
              (p.plugin.diagnostics ?? []).length && "checker",
            ].filter(Boolean)
            : [];
          return (
            <Box key={p.id} flexDirection="column">
              <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                {p.scope === "starter" ? <Text color={C.accent2} bold>+ ADD</Text> : toggle(enabled)}
                <Text color={C.text} bold> {p.plugin?.name ?? p.id}</Text>
                <Text color={C.dim}> {p.plugin?.version ? `v${p.plugin.version} · ` : ""}{p.scope === "starter" ? "starter, optional" : p.scope}{parts.length ? ` · ${parts.join(", ")}` : ""}</Text>
              </Text>
              {state === "changed"
                ? <Text color={C.yellow} wrap="truncate-end">    ⚠ Changed since you enabled it. Review the code, then press Enter to enable again.</Text>
                : p.error
                  ? <Text color={C.red} wrap="truncate-end">    ✖ {p.error}</Text>
                  : <Text color={C.dim} wrap="truncate-end">    {p.plugin?.description ?? (enabled ? "" : "Enable to load it.")}</Text>}
            </Box>
          );
        })}
        <Text> </Text>
        <Text color={C.dim} wrap="truncate-end">Starters: Enter adds one to {PLUGIN_DIRS.find((d) => d.scope === "user")!.dir}, where you can edit it.</Text>
        <Text color={C.dim} wrap="truncate-end">Write your own: /plugins new &lt;name&gt;, or drop a .js/.mjs file into {PLUGIN_DIRS.map((d) => d.dir).join(" or ")}, then press r.</Text>
      </Box>
    );
  };

  const hints = tab === "Model"
    ? connecting ? "Enter next · Esc cancel" : column === "models" ? `↑↓ choose · Enter use model · ← providers${provider.connect ? " · k change key" : ""}` : `↑↓ provider · Enter/→ ${provider.unavailable() ? "connect" : "pick a model"}${provider.connect ? " · k change key" : ""}`
    : tab === "Engine" ? "↑↓ move · Enter use this engine" : tab === "Preferences" ? "↑↓ move · Enter/Space toggle · ←→ change option" : tab === "Games" ? "↑↓ move · Enter add / remove · /games opens the panel" : "↑↓ move · Enter toggle · r rescan";

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text>
        <Text color={C.accent2} bold>⚙ Settings  </Text>
        {TABS.map((t) => (
          <Text key={t} {...(t === tab ? { backgroundColor: C.accent2, color: "black" } : { color: C.dim })} bold={t === tab}>{` ${t} `}</Text>
        ))}
        <Text color={C.dim}>   current: </Text><Text color={C.green}>{describe(choice)}</Text>
        <Text color={C.dim}>   nou v{currentVersion()}</Text>
      </Text>
      <Text> </Text>
      {body()}
      <Text color={C.dim}> Tab next section · {hints} · Esc close   <Text color={C.dim}>saved to ~/.nou/config.json</Text></Text>
    </Box>
  );
}

/** What a connect field starts with: the current URL to edit (keys stay hidden, so they start empty). */
function initialValue(f: { env: string; secret?: boolean }): string {
  return f.secret ? "" : process.env[f.env] ?? "";
}
