import { Component, memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { GAMES, gameById, type Game, type Input } from "../games/index.js";
import { C } from "./theme.js";

/** The panel's tallest height (borders included) when docked under a pane, and the least it needs. */
export const GAME_PANEL = { height: 19, minWidth: 26, minHeight: 10 } as const;

type Props = {
  width: number;
  height: number;
  focused: boolean;
  /** Being dragged to another pane: says so in its title. */
  moving?: boolean;
  /** Games you've added in settings. */
  installed: string[];
  /** Each game's best score so far, and where a new one is saved. */
  best?: Record<string, number>;
  onScore?(game: string, score: number): void;
  /** Esc: back to the code (the game pauses). */
  onLeave(): void;
  onOpenSettings(): void;
};

const KEYS: Record<string, Input> = { w: "up", s: "down", a: "left", d: "right", k: "up", j: "down", h: "left", l: "right" };

/** A row of the playfield, colored per character in runs so it stays a handful of Text nodes. */
function Row({ line, colors }: { line: string; colors: Record<string, string> }) {
  const runs: { text: string; color: string | undefined }[] = [];
  for (const ch of line) {
    const color = colors[ch];
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += ch;
    else runs.push({ text: ch, color });
  }
  return <Text>{runs.map((r, i) => <Text key={i} {...(r.color ? { color: r.color } : {})}>{r.text}</Text>)}</Text>;
}

/**
 * A panel for little games, docked under a pane (drag its title to another pane; × closes it). The app gives it
 * the keyboard while it's focused; a game only runs while it has the keyboard, so it pauses as you leave.
 */
/**
 * Keeps a game that throws from taking Nou down with it: the panel says so, and you can pick another.
 */
export class GameGuard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Box borderStyle="round" borderColor={C.red} flexDirection="column" paddingX={1}>
        <Text color={C.red}>The game stopped: {this.state.error.slice(0, 80)}</Text>
        <Text color={C.dim}>Close the panel (×) and open it again with /games.</Text>
      </Box>
    );
  }
}

export const GamePanel = memo(function GamePanel({ width, height, focused, moving, installed, best = {}, onScore, onLeave, onOpenSettings }: Props) {
  const FIELD = { width: Math.max(0, width - 4), height: Math.max(0, height - 6) };
  const fits = (g: Game) => FIELD.width >= g.minWidth && FIELD.height >= g.minHeight;
  const games = installed.map(gameById).filter((g): g is Game => !!g);
  const [row, setRow] = useState(0);
  const [playing, setPlaying] = useState<{ game: Game; state: any } | null>(null);
  const [paused, setPaused] = useState(false);
  const inputs = useRef<Input[]>([]);
  // A game that doesn't fit the panel any more (it was made smaller) waits, saying how much room it needs.
  const tooSmall = !!playing && !fits(playing.game);
  const view = playing && !tooSmall ? playing.game.view(playing.state) : null;
  const running = !!playing && !tooSmall && focused && !paused && !view?.over;
  const tickMs = playing ? playing.game.speed?.(playing.state) ?? playing.game.tickMs : 100;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const pressed = inputs.current;
      inputs.current = [];
      setPlaying((p) => (p ? { ...p, state: p.game.tick(p.state, pressed) } : p));
    }, tickMs);
    return () => clearInterval(timer);
  }, [running, playing?.game, tickMs]);
  // A different size (moved to another pane, or the window changed) starts the game over at that size,
  // once it fits.
  useEffect(() => {
    if (playing && fits(playing.game)) setPlaying({ game: playing.game, state: playing.game.create(FIELD.width, FIELD.height) });
  }, [FIELD.width, FIELD.height]);
  // A finished game's score goes into the best scores.
  const final = view?.over ? view.score ?? 0 : null;
  const newBest = final !== null && playing !== null && final > (best[playing.game.id] ?? 0);
  useEffect(() => {
    if (newBest && playing) onScore?.(playing.game.id, final!);
  }, [newBest]);

  const start = (game: Game) => {
    if (!fits(game)) return;
    inputs.current = [];
    setPaused(false);
    setPlaying({ game, state: game.create(FIELD.width, FIELD.height) });
  };

  useInput((input, key) => {
    if (key.escape) return onLeave();
    if (!playing) {
      if (key.upArrow || input === "k") setRow((r) => Math.max(0, r - 1));
      else if (key.downArrow || input === "j") setRow((r) => Math.min(games.length - 1, r + 1));
      else if ((key.return || input === " ") && games[row]) start(games[row]);
      else if (input === "s" && !games.length) onOpenSettings();
      return;
    }
    if (input === "q") return setPlaying(null);
    if (view?.over) {
      if (key.return || input === " " || input === "r") start(playing.game);
      return;
    }
    if (input === " " || input === "p") return setPaused((p) => !p);
    const pressed: Input | undefined = key.return ? "action" : key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : KEYS[input];
    if (pressed) inputs.current.push(pressed);
  }, { isActive: focused });

  const color = focused || moving ? C.accent2 : C.dim;
  const inner = width - 2;
  const title = moving ? " ✦ Drop it on a pane: files, code or chat" : `${playing ? ` ✦ ${playing.game.title}` : " ✦ Games"}  ⠿ drag to move · top edge resizes`;
  // The title row: the name and the drag handle, and × (close) at the right.
  const head = title.length > inner - 3 ? `${title.slice(0, inner - 4)}…` : title.padEnd(inner - 3);
  const hint = !focused ? "click to play" : playing ? (view?.over ? "Enter again · q games · Esc leave" : `${paused ? "PAUSED · " : ""}Space pause · q games · Esc leave`) : "↑↓ choose · Enter play · Esc leave";
  const small = width < GAME_PANEL.minWidth || height < GAME_PANEL.minHeight;

  return (
    <Box width={width} height={height} flexDirection="column" borderStyle="round" borderColor={color} overflow="hidden">
      <Text backgroundColor={C.panel} wrap="truncate-end"><Text color={color} bold>{head}</Text><Text color={C.text} bold> × </Text></Text>
      {small ? (
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
          <Text color={C.dim} wrap="wrap">Too small here: drag me to a bigger pane, or make this one wider.</Text>
        </Box>
      ) : null}
      {small ? null : playing && tooSmall ? (
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
          <Text color={C.yellow} wrap="wrap">{playing.game.title} needs more room: a field of {playing.game.minWidth}×{playing.game.minHeight}, and this one is {FIELD.width}×{FIELD.height}.</Text>
          <Text color={C.dim} wrap="wrap">Drag the top edge up, move the panel to a wider pane, or q for another game.</Text>
        </Box>
      ) : playing && view ? (
        <Box flexDirection="column" paddingX={1} height={FIELD.height + 2}>
          {view.lines.map((line, i) => {
            // The end-of-game message goes over the middle of the field.
            if (view.over && i === Math.floor(FIELD.height / 2)) {
              const msg = ` ${view.over}${newBest ? " New best!" : ""} `;
              const left = Math.max(0, Math.floor((FIELD.width - msg.length) / 2));
              return <Text key={i}>{line.slice(0, left)}<Text backgroundColor={C.yellow} color="black" bold>{msg}</Text>{line.slice(left + msg.length)}</Text>;
            }
            return <Row key={i} line={line} colors={playing.game.colors} />;
          })}
          <Text color={C.dim}>{"─".repeat(FIELD.width)}</Text>
          <Text color={C.text} wrap="truncate-end">{view.status}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1} height={FIELD.height + 2}>
          {games.length === 0 ? (
            <>
              <Text color={C.text}>No games yet.</Text>
              <Text color={C.dim} wrap="wrap">Add some in settings → Games{focused ? " (press s)" : ""}: {GAMES.map((g) => g.title).join(", ")}.</Text>
            </>
          ) : (
            <>
              {games.map((g, i) => (
                <Text key={g.id} wrap="truncate-end" {...(i === row && focused ? { backgroundColor: C.panel } : {})}>
                  <Text color={i === row ? C.accent2 : C.dim}>{i === row ? "▸ " : "  "}</Text>
                  <Text color={fits(g) ? C.text : C.dim} bold={i === row}>{g.title}</Text>
                  {best[g.id] ? <Text color={C.yellow}>  best {best[g.id]}</Text> : null}
                  {fits(g) ? null : <Text color={C.dim}>  (needs more room)</Text>}
                </Text>
              ))}
              {games[row] ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={C.dim} wrap="wrap">{games[row]!.blurb}</Text>
                  <Text color={C.accent2} wrap="truncate-end">{games[row]!.controls}</Text>
                </Box>
              ) : null}
            </>
          )}
        </Box>
      )}
      <Text color={C.dim} wrap="truncate-end"> {hint}</Text>
    </Box>
  );
});

export { GAMES };
