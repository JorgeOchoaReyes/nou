import { useEffect, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import TextInput from "ink-text-input";
import { EFFORTS, type Settings as SettingsType } from "../config/index.js";
import { PLUGIN_DIRS, type PluginEntry } from "../plugins/index.js";
import { describe, providers, type ModelChoice } from "../providers/index.js";
import { C, SPINNER } from "./theme.js";

type Props = {
  width: number;
  height: number;
  settings: SettingsType;
  choice: ModelChoice;
  plugins: PluginEntry[];
  onModel(choice: ModelChoice): void;
  onChange(patch: Partial<SettingsType>): void;
  onTogglePlugin(id: string, enabled: boolean): void;
  onRescanPlugins(): void;
  onClose(): void;
};

const TABS = ["Model", "Preferences", "Plugins"] as const;
type Tab = (typeof TABS)[number];

type Pref = { key: keyof SettingsType; label: string; help: string; warn?: boolean };
const PREFS: Pref[] = [
  { key: "effort", label: "Reasoning effort", help: "How hard Claude thinks (low → max). Higher is smarter but slower and pricier." },
  { key: "followMode", label: "Follow mode on start", help: "The code view jumps to files Nou reads and edits." },
  { key: "gitContext", label: "Git context", help: "Give the model your branch, changes and commits, plus git tools." },
  { key: "autoApproveEdits", label: "Auto-approve edits", help: "Apply file edits without asking (diffs are still shown).", warn: true },
  { key: "autoApproveCommands", label: "Auto-approve commands", help: "Run shell commands without asking. Only turn on if you trust the model.", warn: true },
];

export function Settings({ width, height, settings, choice, plugins, onModel, onChange, onTogglePlugin, onRescanPlugins, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("Model");
  const [row, setRow] = useState(0);
  const [column, setColumn] = useState<"providers" | "models">("providers");
  const [modelRow, setModelRow] = useState(0);
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const [models, setModels] = useState<Record<string, string[] | { error: string } | "loading">>({});
  const { frame } = useAnimation({ interval: 80 });

  const provider = providers[row] ?? providers[0]!;
  const listed = models[provider.id];

  // Load the model list for the highlighted provider.
  useEffect(() => {
    if (tab !== "Model" || provider.unavailable() || models[provider.id]) return;
    setModels((m) => ({ ...m, [provider.id]: "loading" }));
    provider.listModels()
      .then((list) => setModels((m) => ({ ...m, [provider.id]: list })))
      .catch((error) => setModels((m) => ({ ...m, [provider.id]: { error: String(error.message ?? error) } })));
  }, [tab, provider.id]);

  const modelItems = Array.isArray(listed) ? listed : [];
  const rowsFor = (t: Tab) => (t === "Model" ? providers.length : t === "Preferences" ? PREFS.length : plugins.length);

  useInput((input, key) => {
    if (typing) {
      if (key.escape) setTyping(false);
      return;
    }
    if (key.tab) {
      const next = TABS[(TABS.indexOf(tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]!;
      setTab(next);
      setRow(next === "Model" ? Math.max(0, providers.indexOf(choice.provider)) : 0);
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
      }
    } else if (tab === "Preferences" && (key.return || input === " " || key.leftArrow || key.rightArrow)) {
      const pref = PREFS[row]!;
      if (pref.key === "effort") {
        const step = key.leftArrow ? -1 : 1;
        onChange({ effort: EFFORTS[(EFFORTS.indexOf(settings.effort) + step + EFFORTS.length) % EFFORTS.length]! });
      } else {
        onChange({ [pref.key]: !settings[pref.key] } as Partial<SettingsType>);
      }
    } else if (tab === "Plugins") {
      if (input === "r") onRescanPlugins();
      else if ((key.return || input === " ") && plugins[row]) onTogglePlugin(plugins[row].id, !settings.plugins[plugins[row].id]);
    }
  });

  const boxHeight = height - 6;
  const toggle = (on: boolean, warn?: boolean) => (
    <Text color={on ? (warn ? C.orange : C.green) : C.dim} bold>{on ? "● ON " : "○ OFF"}</Text>
  );

  const body = () => {
    if (tab === "Model") {
      const leftWidth = Math.min(46, Math.floor(width * 0.45));
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
                  <Text color={problem ? C.dim : C.text} bold={selected}>{p.label.padEnd(26).slice(0, 26)}</Text>
                  <Text color={p.local ? C.green : C.accent2}>{p.local ? " local" : " cloud"}</Text>
                  {problem ? <Text color={C.dim}> 🔒</Text> : null}
                </Text>
              );
            })}
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={column === "models" ? C.accent : C.dim} paddingX={1}>
            <Text color={C.dim} bold>MODELS · {provider.label}</Text>
            {provider.unavailable() ? (
              <>
                <Text color={C.yellow}>Not set up: {provider.unavailable()}</Text>
                <Text color={C.dim}>Add it to a .env file in your project (see .env.example) or your environment, then restart Nou.</Text>
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
                {listed && typeof listed === "object" && !Array.isArray(listed) && <Text color={C.red}>Couldn't list models: {listed.error}</Text>}
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

    if (tab === "Preferences") {
      return (
        <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1}>
          {PREFS.map((pref, i) => {
            const selected = i === row;
            const value = settings[pref.key];
            return (
              <Box key={pref.key} flexDirection="column" marginBottom={1}>
                <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                  <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                  <Text color={C.text} bold={selected}>{pref.label.padEnd(26)}</Text>
                  {pref.key === "effort"
                    ? <Text>{EFFORTS.map((e) => <Text key={e} color={e === value ? C.accent2 : C.dim} bold={e === value}>{e === value ? `[${e}]` : ` ${e} `}</Text>)}</Text>
                    : toggle(value as boolean, pref.warn)}
                </Text>
                <Text color={C.dim}>    {pref.help}</Text>
              </Box>
            );
          })}
        </Box>
      );
    }

    return (
      <Box flexDirection="column" height={boxHeight} borderStyle="round" borderColor={C.accent} paddingX={1}>
        {plugins.length === 0 ? (
          <>
            <Text color={C.text}>No plugins found.</Text>
            <Text> </Text>
            <Text color={C.dim}>Drop a .js/.mjs/.ts file (or a folder with index.*) into one of:</Text>
            {PLUGIN_DIRS.map((d) => <Text key={d.dir} color={C.cyan}>  {d.dir}  <Text color={C.dim}>({d.scope})</Text></Text>)}
            <Text> </Text>
            <Text color={C.dim}>See examples/plugins/word-count.mjs for the shape. Press r to rescan.</Text>
          </>
        ) : plugins.map((p, i) => {
          const selected = i === row;
          const enabled = !!settings.plugins[p.id];
          return (
            <Box key={p.id} flexDirection="column" marginBottom={1}>
              <Text {...(selected ? { backgroundColor: C.panel } : {})}>
                <Text color={selected ? C.accent2 : C.dim}>{selected ? "▸ " : "  "}</Text>
                {toggle(enabled)}
                <Text color={C.text} bold> {p.plugin?.name ?? p.id}</Text>
                <Text color={C.dim}> {p.plugin?.version ? `v${p.plugin.version} · ` : ""}{p.scope}</Text>
              </Text>
              {p.error
                ? <Text color={C.red}>    ✖ {p.error}</Text>
                : <Text color={C.dim}>    {p.plugin?.description ?? (enabled ? "" : "Enable to load it.")}
                  {p.plugin ? `  [${(p.plugin.tools ?? []).length} tools, ${(p.plugin.commands ?? []).length} commands]` : ""}</Text>}
            </Box>
          );
        })}
      </Box>
    );
  };

  const hints = tab === "Model"
    ? column === "models" ? "↑↓ choose · Enter use model · ← providers" : "↑↓ provider · Enter/→ pick a model"
    : tab === "Preferences" ? "↑↓ move · Enter/Space toggle · ←→ change effort" : "↑↓ move · Enter toggle · r rescan";

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text>
        <Text color={C.accent2} bold>⚙ Settings  </Text>
        {TABS.map((t) => (
          <Text key={t} {...(t === tab ? { backgroundColor: C.accent2, color: "black" } : { color: C.dim })} bold={t === tab}>{` ${t} `}</Text>
        ))}
        <Text color={C.dim}>   current: </Text><Text color={C.green}>{describe(choice)}</Text>
      </Text>
      <Text> </Text>
      {body()}
      <Text color={C.dim}> Tab next section · {hints} · Esc close   <Text color={C.dim}>saved to ~/.nou/config.json</Text></Text>
    </Box>
  );
}
