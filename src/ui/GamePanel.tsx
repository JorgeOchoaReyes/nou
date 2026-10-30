import { memo, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { GAMES, gameById, type Game, type Input } from "../games/index.js";
import { C } from "./theme.js";

/** The panel's size on screen, borders included. */
export const GAME_PANEL = { width: 40, height: 19 } as const;
const FIELD = { width: GAME_PANEL.width - 4, height: GAME_PANEL.height - 6 };

type Props = {
  /** Top-left corner, in screen cells. */
  x: number;
  y: number;
  focused: boolean;
  /** Games you've added in settings. */
  installed: string[];
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
 * A floating panel for little games. The app places it (it can be dragged by its title bar) and gives it
 * the keyboard while it's focused; a game only runs while it has the keyboard, so it pauses as you leave.
 */
export const GamePanel = memo(function GamePanel({ x, y, focused, installed, onLeave, onOpenSettings }: Props) {
  const games = installed.map(gameById).filter((g): g is Game => !!g);
  const [row, setRow] = useState(0);
  const [playing, setPlaying] = useState<{ game: Game; state: any } | null>(null);
  const [paused, setPaused] = useState(false);
  const inputs = useRef<Input[]>([]);
  const view = playing ? playing.game.view(playing.state) : null;
  const running = !!playing && focused && !paused && !view?.over;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const pressed = inputs.current;
      inputs.current = [];
      setPlaying((p) => (p ? { ...p, state: p.game.tick(p.state, pressed) } : p));
    }, playing!.game.tickMs);
    return () => clearInterval(timer);
  }, [running, playing?.game]);

  const start = (game: Game) => {
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
    const pressed: Input | undefined = key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : KEYS[input];
    if (pressed) inputs.current.push(pressed);
  }, { isActive: focused });

  const color = focused ? C.accent2 : C.dim;
  const inner = GAME_PANEL.width - 2;
  const pad = (s: string) => (s.length >= inner ? s.slice(0, inner) : s + " ".repeat(inner - s.length));
  const title = playing ? ` ✦ ${playing.game.title}` : " ✦ Games";
  const hint = !focused ? "click to play · drag the title to move" : playing ? (view?.over ? "Enter again · q games · Esc leave" : `${paused ? "PAUSED · " : ""}Space pause · q games · Esc leave`) : "↑↓ choose · Enter play · Esc leave";

  return (
    <Box position="absolute" top={y} left={x} width={GAME_PANEL.width} height={GAME_PANEL.height} flexDirection="column" borderStyle="round" borderColor={color}>
      <Text backgroundColor={C.panel} color={color} bold wrap="truncate-end">{pad(`${title}  ⠿ drag`)}</Text>
      {playing && view ? (
        <Box flexDirection="column" paddingX={1} height={FIELD.height + 2}>
          {view.lines.map((line, i) => {
            // The end-of-game message goes over the middle of the field.
            if (view.over && i === Math.floor(FIELD.height / 2)) {
              const msg = ` ${view.over} `;
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
              <Text color={C.dim} wrap="wrap">Add some in settings → Games{focused ? " (press s)" : ""}: Pong, Snake and Breakout.</Text>
            </>
          ) : games.map((g, i) => (
            <Box key={g.id} flexDirection="column" marginBottom={1}>
              <Text {...(i === row && focused ? { backgroundColor: C.panel } : {})}>
                <Text color={i === row ? C.accent2 : C.dim}>{i === row ? "▸ " : "  "}</Text>
                <Text color={C.text} bold={i === row}>{g.title}</Text>
                <Text color={C.dim}>  {g.controls}</Text>
              </Text>
              <Text color={C.dim} wrap="truncate-end">    {g.blurb}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Text color={C.dim} wrap="truncate-end"> {hint}</Text>
    </Box>
  );
});

export { GAMES };
