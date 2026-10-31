/**
 * Little games for the Games panel, drawn with text. Each one is plain state and three functions, so the
 * panel can run any of them and the tests can play them without a terminal.
 */

/** What the player pressed since the last tick ("action" is Enter: jump, flip...). */
export type Input = "up" | "down" | "left" | "right" | "action";

export type GameView = {
  /** The playfield, one string per row, all the same width. */
  lines: string[];
  /** A line under it: score, lives, how to play. */
  status: string;
  /** Set when the game has ended: what to say. */
  over?: string;
  /** The score so far, for the best-score table. */
  score?: number;
};

export type Game<S = any> = {
  id: string;
  title: string;
  /** One line for the settings list. */
  blurb: string;
  controls: string;
  /** Milliseconds between ticks. */
  tickMs: number;
  /** The smallest playfield it can be played on; a smaller panel says so instead of starting it. */
  minWidth: number;
  minHeight: number;
  /** Ticks faster as the game goes on (milliseconds for this state); tickMs when absent. */
  speed?(state: S): number;
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

const blank = (w: number, h: number) => Array.from({ length: Math.max(0, h) }, () => Array<string>(Math.max(0, w)).fill(" "));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Draws a character if (x, y) is on the grid: games never write outside it, whatever its size. */
const put = (grid: string[][], x: number, y: number, ch: string) => {
  if (grid[y]?.[x] !== undefined) grid[y]![x] = ch;
};

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
  minWidth: 16,
  minHeight: 6,
  colors: { "█": "#61afef", "●": "#e5c07b", "┊": "#5c6370" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
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
    for (let y = 0; y < s.h; y += 2) put(grid, Math.floor(s.w / 2), y, "┊");
    for (let k = 0; k < PADDLE; k++) {
      put(grid, 1, s.you + k, "█");
      put(grid, s.w - 2, Math.round(s.them) + k, "█");
    }
    put(grid, Math.round(s.bx), Math.round(s.by), "●");
    const [a, b] = s.scores;
    return {
      lines: grid.map((r) => r.join("")),
      score: a,
      status: `you ${a} · ${b} computer   ↑↓ move`,
      ...(a >= PONG_WIN ? { over: "You win! ✦" } : b >= PONG_WIN ? { over: "The computer wins." } : {}),
    };
  },
};

// --- Snake -----------------------------------------------------------------------------------------

type Point = { x: number; y: number };
type Dir = Exclude<Input, "action">;
type SnakeState = { w: number; h: number; body: Point[]; dir: Dir; food: Point; score: number; dead: boolean; random: () => number };
const DIRS: Record<Dir, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

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
  minWidth: 10,
  minHeight: 5,
  // A little faster with every few eaten, down to a floor.
  speed: (s) => Math.max(55, 110 - Math.floor(s.score / 3) * 8),
  colors: { "█": "#98c379", "▓": "#7ec16e", "◆": "#e06c75" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
    const y = Math.floor(h / 2);
    const s: SnakeState = { w, h, body: [{ x: 4, y }, { x: 3, y }, { x: 2, y }], dir: "right", food: { x: 0, y: 0 }, score: 0, dead: false, random: rng(seed) };
    return { ...s, food: placeFood(s) };
  },
  tick(s, inputs) {
    if (s.dead) return s;
    let dir = s.dir;
    // One turn per tick (the first that isn't straight back), so quick double taps don't fold it onto itself.
    for (const i of inputs) {
      if (i !== "action" && i !== OPPOSITE[dir] && i !== dir) {
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
    put(grid, s.food.x, s.food.y, "◆");
    s.body.forEach((b, i) => put(grid, b.x, b.y, i === 0 ? "█" : "▓"));
    return { lines: grid.map((r) => r.join("")), score: s.score, status: `length ${s.body.length} · score ${s.score}`, ...(s.dead ? { over: `Game over: ${s.score} eaten.` } : {}) };
  },
};

// --- Breakout --------------------------------------------------------------------------------------

type BreakoutState = { w: number; h: number; paddle: number; bx: number; by: number; vx: number; vy: number; bricks: boolean[][]; lives: number; score: number; level: number; random: () => number };
const PAD = 7;
const BRICK_ROWS = 4;

function launch(s: BreakoutState): BreakoutState {
  // Each level the ball starts a little faster.
  const pace = 0.6 * (1 + (s.level - 1) * 0.12);
  return { ...s, bx: s.paddle + PAD / 2, by: s.h - 3, vx: (s.random() < 0.5 ? -1 : 1) * pace, vy: -pace };
}
const wall = (w: number) => Array.from({ length: BRICK_ROWS }, () => Array<boolean>(Math.floor(w / 3)).fill(true));

export const breakout: Game<BreakoutState> = {
  id: "breakout",
  title: "Breakout",
  blurb: "Knock out every brick with the ball; each wall you clear brings a faster one. Three lives.",
  controls: "←→ or a/d move",
  tickMs: 45,
  minWidth: 18,
  minHeight: 9,
  colors: { "▀": "#e06c75", "▄": "#d19a66", "▬": "#61afef", "●": "#e5c07b" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
    const s: BreakoutState = {
      w, h, paddle: Math.floor((w - PAD) / 2), bx: 0, by: 0, vx: 0, vy: 0,
      bricks: wall(w), lives: 3, score: 0, level: 1, random: rng(seed),
    };
    return launch(s);
  },
  tick(s, inputs) {
    if (s.lives <= 0) return s;
    // A cleared wall: the next level, a little faster.
    if (s.bricks.every((r) => r.every((b) => !b))) return launch({ ...s, bricks: wall(s.w), level: s.level + 1 });
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
      if (alive) for (let k = 0; k < 3; k++) put(grid, x * 3 + k, y + 1, y % 2 ? "▄" : "▀");
    }));
    for (let k = 0; k < PAD; k++) put(grid, s.paddle + k, s.h - 1, "▬");
    if (s.lives > 0) put(grid, Math.round(s.bx), Math.round(s.by), "●");
    return {
      lines: grid.map((r) => r.join("")),
      score: s.score,
      status: `level ${s.level} · score ${s.score} · lives ${"♥".repeat(Math.max(0, s.lives))}`,
      ...(s.lives <= 0 ? { over: `Game over: ${s.score} points, level ${s.level}.` } : {}),
    };
  },
};

// --- Dodge -----------------------------------------------------------------------------------------

type DodgeState = { w: number; h: number; x: number; rocks: Point[]; stars: Point[]; score: number; ticks: number; dead: boolean; random: () => number };

/** Rocks fall; slide along the bottom to dodge them and catch the stars. It gets busier as you last. */
export const dodge: Game<DodgeState> = {
  id: "dodge",
  title: "Dodge",
  blurb: "Rocks fall faster and thicker the longer you last. Catch ★ for points.",
  controls: "←→ or a/d move",
  tickMs: 90,
  minWidth: 12,
  minHeight: 6,
  speed: (s) => Math.max(45, 90 - Math.floor(s.ticks / 60) * 5),
  colors: { "▲": "#61afef", "●": "#d19a66", "★": "#e5c07b" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
    return { w, h, x: Math.floor(w / 2), rocks: [], stars: [], score: 0, ticks: 0, dead: false, random: rng(seed) };
  },
  tick(s, inputs) {
    if (s.dead) return s;
    let x = s.x;
    for (const i of inputs) x += i === "left" ? -1 : i === "right" ? 1 : 0;
    x = clamp(x, 0, s.w - 1);
    const fall = (p: Point) => ({ x: p.x, y: p.y + 1 });
    const rocks = s.rocks.map(fall).filter((p) => p.y < s.h);
    let stars = s.stars.map(fall).filter((p) => p.y < s.h);
    // More rocks per row as the game goes on.
    const chance = Math.min(0.55, 0.18 + s.ticks / 900);
    if (s.random() < chance) rocks.push({ x: Math.floor(s.random() * s.w), y: 0 });
    if (s.random() < 0.05) stars.push({ x: Math.floor(s.random() * s.w), y: 0 });
    const at = (p: Point) => p.x === x && p.y === s.h - 1;
    let score = s.score + (s.ticks % 10 === 9 ? 1 : 0);
    if (stars.some(at)) {
      score += 10;
      stars = stars.filter((p) => !at(p));
    }
    const dead = rocks.some(at);
    return { ...s, x, rocks, stars, score, ticks: s.ticks + 1, dead };
  },
  view(s) {
    const grid = blank(s.w, s.h);
    for (const r of s.rocks) put(grid, r.x, r.y, "●");
    for (const r of s.stars) put(grid, r.x, r.y, "★");
    put(grid, s.x, s.h - 1, "▲");
    return { lines: grid.map((r) => r.join("")), score: s.score, status: `score ${s.score}`, ...(s.dead ? { over: `Hit! ${s.score} points.` } : {}) };
  },
};

// --- Hop -------------------------------------------------------------------------------------------

type HopState = { w: number; h: number; y: number; vy: number; walls: { x: number; tall: number }[]; score: number; ticks: number; dead: boolean; random: () => number };
const HOP_X = 3;

/** Run along the ground and hop the walls that come at you; they come faster as you go. */
export const hop: Game<HopState> = {
  id: "hop",
  title: "Hop",
  blurb: "Run and hop over the walls coming at you. One hit and it's over.",
  controls: "↑ or Enter hops",
  tickMs: 70,
  minWidth: 20,
  minHeight: 6,
  speed: (s) => Math.max(35, 70 - Math.floor(s.score / 5) * 4),
  colors: { "◉": "#98c379", "█": "#c678dd", "▔": "#5c6370" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
    return { w, h, y: 0, vy: 0, walls: [], score: 0, ticks: 0, dead: false, random: rng(seed) };
  },
  tick(s, inputs) {
    if (s.dead) return s;
    // Height above the ground; a hop goes up and comes back down.
    let { y, vy } = s;
    if (y === 0 && inputs.some((i) => i === "up" || i === "action")) vy = 1.15;
    y = Math.max(0, y + vy);
    vy = y === 0 ? 0 : vy - 0.22;
    const walls = s.walls.map((wl) => ({ ...wl, x: wl.x - 1 })).filter((wl) => wl.x >= 0);
    const passed = s.walls.length - walls.length;
    const last = walls[walls.length - 1];
    // A new wall, far enough from the last that every gap can be cleared.
    if ((!last || last.x < s.w - 9) && s.random() < 0.12) walls.push({ x: s.w - 1, tall: 1 + Math.floor(s.random() * Math.min(2, s.h - 3)) });
    const dead = walls.some((wl) => wl.x === HOP_X && Math.round(y) < wl.tall);
    return { ...s, y, vy, walls, score: s.score + passed, ticks: s.ticks + 1, dead };
  },
  view(s) {
    const grid = blank(s.w, s.h);
    const ground = s.h - 1;
    for (let x = 0; x < s.w; x++) put(grid, x, ground, "▔");
    for (const wl of s.walls) for (let k = 1; k <= wl.tall; k++) put(grid, wl.x, ground - k, "█");
    put(grid, HOP_X, ground - 1 - Math.round(s.y), "◉");
    return { lines: grid.map((r) => r.join("")), score: s.score, status: `walls hopped ${s.score}`, ...(s.dead ? { over: `Bonk! ${s.score} hopped.` } : {}) };
  },
};

// --- Pairs -----------------------------------------------------------------------------------------

type PairsState = { cols: number; rows: number; w: number; h: number; cards: string[]; found: boolean[]; open: number[]; cursor: number; moves: number; wait: number };
const SYMBOLS = ["◆", "●", "▲", "■", "★", "♥", "♣", "♠", "☀", "☂", "♪", "✿"];

/** Cards face down: flip two at a time and find every matching pair in as few moves as you can. */
export const pairs: Game<PairsState> = {
  id: "pairs",
  title: "Pairs",
  blurb: "Flip two cards at a time; find every matching pair in as few moves as you can.",
  controls: "arrows move · Enter flips",
  tickMs: 100,
  minWidth: 16,
  minHeight: 5,
  colors: { "◆": "#e06c75", "●": "#e5c07b", "▲": "#61afef", "■": "#98c379", "★": "#e5c07b", "♥": "#e06c75", "♣": "#98c379", "♠": "#c678dd", "☀": "#d19a66", "☂": "#56b6c2", "♪": "#c678dd", "✿": "#56b6c2", "▒": "#5c6370", "▸": "#e5c07b", "◂": "#e5c07b" },
  create(w, h, seed = Date.now()) {
    [w, h] = [Math.max(w, this.minWidth), Math.max(h, this.minHeight)];
    // As many cards as fit (each 4 wide, rows 2 apart), an even number, up to every symbol twice.
    const cols = Math.max(2, Math.min(6, Math.floor(w / 4)));
    const rows = Math.max(2, Math.min(4, Math.floor((h + 1) / 2)));
    const count = Math.min(SYMBOLS.length * 2, cols * rows - ((cols * rows) % 2));
    const random = rng(seed);
    const deck = SYMBOLS.slice(0, count / 2).flatMap((sym) => [sym, sym]);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return { cols, rows, w, h, cards: deck, found: deck.map(() => false), open: [], cursor: 0, moves: 0, wait: 0 };
  },
  tick(s, inputs) {
    if (s.found.every(Boolean)) return s;
    let { cursor, open, found, moves, wait } = s;
    // Two face-up cards that don't match stay shown a moment, then turn back over.
    if (open.length === 2 && wait > 0) {
      wait--;
      if (wait === 0) open = [];
      return { ...s, open, wait };
    }
    const n = s.cards.length;
    for (const i of inputs) {
      if (i === "left") cursor = (cursor + n - 1) % n;
      else if (i === "right") cursor = (cursor + 1) % n;
      else if (i === "up") cursor = cursor - s.cols >= 0 ? cursor - s.cols : cursor;
      else if (i === "down") cursor = cursor + s.cols < n ? cursor + s.cols : cursor;
      else if (i === "action" && !found[cursor] && !open.includes(cursor) && open.length < 2) {
        open = [...open, cursor];
        if (open.length === 2) {
          moves++;
          if (s.cards[open[0]!] === s.cards[open[1]!]) {
            found = found.map((f, k) => f || open.includes(k));
            open = [];
          } else wait = 8;
        }
      }
    }
    return { ...s, cursor, open, found, moves, wait };
  },
  view(s) {
    const grid = blank(s.w, s.h);
    s.cards.forEach((card, i) => {
      const x = (i % s.cols) * 4;
      const y = Math.floor(i / s.cols) * 2;
      const shown = s.found[i] || s.open.includes(i);
      if (i === s.cursor) {
        put(grid, x, y, "▸");
        put(grid, x + 2, y, "◂");
      }
      put(grid, x + 1, y, s.found[i] ? card : shown ? card : "▒");
    });
    const done = s.found.every(Boolean);
    const pairsLeft = s.found.filter((f) => !f).length / 2;
    // Fewer moves is better: the score counts what you saved.
    const score = Math.max(0, s.cards.length * 2 - s.moves);
    return { lines: grid.map((r) => r.join("")), score, status: `moves ${s.moves} · ${pairsLeft} pairs left`, ...(done ? { over: `All found in ${s.moves} moves ✦` } : {}) };
  },
};

/** Every game Nou has, in the order settings lists them. */
export const GAMES: Game[] = [pong, snake, breakout, dodge, hop, pairs];
export const gameById = (id: string) => GAMES.find((g) => g.id === id);
