/**
 * Little games for the Games panel, drawn with text. Each one is plain state and three functions, so the
 * panel can run any of them and the tests can play them without a terminal.
 */

/** What the player pressed since the last tick. */
export type Input = "up" | "down" | "left" | "right";

export type GameView = {
  /** The playfield, one string per row, all the same width. */
  lines: string[];
  /** A line under it: score, lives, how to play. */
  status: string;
  /** Set when the game has ended: what to say. */
  over?: string;
};

export type Game<S = any> = {
  id: string;
  title: string;
  /** One line for the settings list. */
  blurb: string;
  controls: string;
  /** Milliseconds between ticks. */
  tickMs: number;
  create(width: number, height: number, seed?: number): S;
  /** Advances one tick with what was pressed since the last one. */
  tick(state: S, inputs: Input[]): S;
  view(state: S): GameView;
  /** Characters to color, and how. */
  colors: Record<string, string>;
};

/** A small seeded random number generator, so games can be replayed in tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const blank = (w: number, h: number) => Array.from({ length: h }, () => Array<string>(w).fill(" "));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Pong ------------------------------------------------------------------------------------------

type PongState = {
  w: number; h: number;
  you: number; them: number; // paddle tops
  bx: number; by: number; vx: number; vy: number;
  scores: [number, number];
  random: () => number;
};
const PADDLE = 3;
const PONG_WIN = 7;

function serve(s: PongState, toward: 1 | -1): PongState {
  const vy = (s.random() - 0.5) * 1.2;
  return { ...s, bx: s.w / 2, by: s.h / 2, vx: toward * 0.9, vy: Math.abs(vy) < 0.2 ? 0.4 : vy };
}

export const pong: Game<PongState> = {
  id: "pong",
  title: "Pong",
  blurb: "The classic: you on the left, the computer on the right. First to 7.",
  controls: "↑↓ or w/s move",
  tickMs: 50,
  colors: { "█": "#61afef", "●": "#e5c07b", "┊": "#5c6370" },
  create(w, h, seed = Date.now()) {
    const s: PongState = { w, h, you: Math.floor((h - PADDLE) / 2), them: Math.floor((h - PADDLE) / 2), bx: 0, by: 0, vx: 0, vy: 0, scores: [0, 0], random: rng(seed) };
    return serve(s, -1);
  },
  tick(s, inputs) {
    if (s.scores[0] >= PONG_WIN || s.scores[1] >= PONG_WIN) return s;
    let you = s.you;
    for (const i of inputs) you += i === "up" ? -1 : i === "down" ? 1 : 0;
    you = clamp(you, 0, s.h - PADDLE);
    // The computer follows the ball, a bit slower than it moves, so it can be beaten.
    const target = s.by - PADDLE / 2;
    const them = clamp(s.them + clamp(target - s.them, -0.55, 0.55), 0, s.h - PADDLE);
    let { bx, by, vx, vy } = s;
    bx += vx;
    by += vy;
    if (by < 0) [by, vy] = [-by, -vy];
    if (by > s.h - 1) [by, vy] = [2 * (s.h - 1) - by, -vy];
    // Paddles at x=1 and x=w-2; where the ball hits the paddle sets its angle.
    if (vx < 0 && bx <= 1.5 && bx >= 0.5 && by >= you - 0.5 && by <= you + PADDLE - 0.5) {
      [bx, vx, vy] = [1.5, Math.min(1.4, -vx * 1.05), (by - (you + PADDLE / 2 - 0.5)) * 0.5];
    }
    if (vx > 0 && bx >= s.w - 2.5 && bx <= s.w - 1.5 && by >= them - 0.5 && by <= them + PADDLE - 0.5) {
      [bx, vx, vy] = [s.w - 2.5, -Math.min(1.4, vx * 1.05), (by - (them + PADDLE / 2 - 0.5)) * 0.5];
    }
    const next = { ...s, you, them, bx, by, vx, vy };
    if (bx < 0) return serve({ ...next, scores: [s.scores[0], s.scores[1] + 1] }, -1);
    if (bx > s.w - 1) return serve({ ...next, scores: [s.scores[0] + 1, s.scores[1]] }, 1);
    return next;
  },
  view(s) {
    const grid = blank(s.w, s.h);
    for (let y = 0; y < s.h; y += 2) grid[y]![Math.floor(s.w / 2)] = "┊";
    for (let k = 0; k < PADDLE; k++) {
      grid[s.you + k]![1] = "█";
      grid[Math.round(s.them) + k]![s.w - 2] = "█";
    }
    const bx = Math.round(s.bx);
    const by = Math.round(s.by);
    if (grid[by]?.[bx] !== undefined) grid[by]![bx] = "●";
    const [a, b] = s.scores;
    return {
      lines: grid.map((r) => r.join("")),
      status: `you ${a} · ${b} computer   ↑↓ move`,
      ...(a >= PONG_WIN ? { over: "You win! ✦" } : b >= PONG_WIN ? { over: "The computer wins." } : {}),
    };
  },
};

// --- Snake -----------------------------------------------------------------------------------------

type Point = { x: number; y: number };
type SnakeState = { w: number; h: number; body: Point[]; dir: Input; food: Point; score: number; dead: boolean; random: () => number };
const DIRS: Record<Input, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE: Record<Input, Input> = { up: "down", down: "up", left: "right", right: "left" };

function placeFood(s: SnakeState): Point {
  for (let tries = 0; tries < 500; tries++) {
    const p = { x: Math.floor(s.random() * s.w), y: Math.floor(s.random() * s.h) };
    if (!s.body.some((b) => b.x === p.x && b.y === p.y)) return p;
  }
  return { x: 0, y: 0 };
}

export const snake: Game<SnakeState> = {
  id: "snake",
  title: "Snake",
  blurb: "Eat, grow, don't bite yourself or the walls.",
  controls: "arrows or wasd steer",
  tickMs: 110,
  colors: { "█": "#98c379", "▓": "#7ec16e", "◆": "#e06c75" },
  create(w, h, seed = Date.now()) {
    const y = Math.floor(h / 2);
    const s: SnakeState = { w, h, body: [{ x: 4, y }, { x: 3, y }, { x: 2, y }], dir: "right", food: { x: 0, y: 0 }, score: 0, dead: false, random: rng(seed) };
    return { ...s, food: placeFood(s) };
  },
  tick(s, inputs) {
    if (s.dead) return s;
    let dir = s.dir;
    // One turn per tick (the first that isn't straight back), so quick double taps don't fold it onto itself.
    for (const i of inputs) {
      if (i !== OPPOSITE[dir] && i !== dir) {
        dir = i;
        break;
      }
    }
    const head = { x: s.body[0]!.x + DIRS[dir].x, y: s.body[0]!.y + DIRS[dir].y };
    const eats = head.x === s.food.x && head.y === s.food.y;
    const rest = eats ? s.body : s.body.slice(0, -1);
    const dead = head.x < 0 || head.y < 0 || head.x >= s.w || head.y >= s.h || rest.some((b) => b.x === head.x && b.y === head.y);
    if (dead) return { ...s, dir, dead: true };
    const next = { ...s, dir, body: [head, ...rest], score: s.score + (eats ? 1 : 0) };
    return eats ? { ...next, food: placeFood(next) } : next;
  },
  view(s) {
    const grid = blank(s.w, s.h);
    grid[s.food.y]![s.food.x] = "◆";
    s.body.forEach((b, i) => {
      if (grid[b.y]?.[b.x] !== undefined) grid[b.y]![b.x] = i === 0 ? "█" : "▓";
    });
    return { lines: grid.map((r) => r.join("")), status: `length ${s.body.length} · score ${s.score}`, ...(s.dead ? { over: `Game over: ${s.score} eaten.` } : {}) };
  },
};

// --- Breakout --------------------------------------------------------------------------------------

type BreakoutState = { w: number; h: number; paddle: number; bx: number; by: number; vx: number; vy: number; bricks: boolean[][]; lives: number; score: number; random: () => number };
const PAD = 7;
const BRICK_ROWS = 4;

function launch(s: BreakoutState): BreakoutState {
  return { ...s, bx: s.paddle + PAD / 2, by: s.h - 3, vx: (s.random() < 0.5 ? -1 : 1) * 0.6, vy: -0.6 };
}

export const breakout: Game<BreakoutState> = {
  id: "breakout",
  title: "Breakout",
  blurb: "Knock out every brick with the ball. Three lives.",
  controls: "←→ or a/d move",
  tickMs: 45,
  colors: { "▀": "#e06c75", "▄": "#d19a66", "▬": "#61afef", "●": "#e5c07b" },
  create(w, h, seed = Date.now()) {
    const s: BreakoutState = {
      w, h, paddle: Math.floor((w - PAD) / 2), bx: 0, by: 0, vx: 0, vy: 0,
      bricks: Array.from({ length: BRICK_ROWS }, () => Array<boolean>(Math.floor(w / 3)).fill(true)), lives: 3, score: 0, random: rng(seed),
    };
    return launch(s);
  },
  tick(s, inputs) {
    if (s.lives <= 0 || s.bricks.every((r) => r.every((b) => !b))) return s;
    let paddle = s.paddle;
    for (const i of inputs) paddle += i === "left" ? -2 : i === "right" ? 2 : 0;
    paddle = clamp(paddle, 0, s.w - PAD);
    let { bx, by, vx, vy } = s;
    bx += vx;
    by += vy;
    if (bx < 0 || bx > s.w - 1) [bx, vx] = [clamp(bx, 0, s.w - 1), -vx];
    if (by < 0) [by, vy] = [0, -vy];
    // Bricks are three columns wide, on rows 1.. so there's a gap at the top.
    const bricks = s.bricks.map((r) => [...r]);
    let score = s.score;
    const row = Math.floor(by) - 1;
    const col = Math.floor(bx / 3);
    if (row >= 0 && row < BRICK_ROWS && bricks[row]?.[col]) {
      bricks[row]![col] = false;
      score += (BRICK_ROWS - row) * 10;
      vy = -vy;
    }
    // The paddle sits on the last row; where the ball lands on it sets the angle.
    if (vy > 0 && by >= s.h - 2 && by < s.h - 1 && bx >= paddle - 0.5 && bx <= paddle + PAD - 0.5) {
      vy = -Math.abs(vy);
      vx = clamp((bx - (paddle + PAD / 2 - 0.5)) * 0.25, -1, 1) || 0.3;
      by = s.h - 2;
    }
    const next = { ...s, paddle, bx, by, vx, vy, bricks, score };
    if (by > s.h - 1) {
      const lives = s.lives - 1;
      return lives > 0 ? launch({ ...next, lives }) : { ...next, lives };
    }
    return next;
  },
  view(s) {
    const grid = blank(s.w, s.h);
    s.bricks.forEach((r, y) => r.forEach((alive, x) => {
      if (alive) for (let k = 0; k < 3; k++) if (x * 3 + k < s.w - 0) grid[y + 1]![x * 3 + k] = y % 2 ? "▄" : "▀";
    }));
    for (let k = 0; k < PAD; k++) grid[s.h - 1]![s.paddle + k] = "▬";
    const bx = Math.round(s.bx);
    const by = Math.round(s.by);
    if (s.lives > 0 && grid[by]?.[bx] !== undefined) grid[by]![bx] = "●";
    const cleared = s.bricks.every((r) => r.every((b) => !b));
    return {
      lines: grid.map((r) => r.join("")),
      status: `score ${s.score} · lives ${"♥".repeat(Math.max(0, s.lives))}`,
      ...(cleared ? { over: `Cleared! ${s.score} points ✦` } : s.lives <= 0 ? { over: `Game over: ${s.score} points.` } : {}),
    };
  },
};

/** Every game Nou has, in the order settings lists them. */
export const GAMES: Game[] = [pong, snake, breakout];
export const gameById = (id: string) => GAMES.find((g) => g.id === id);
