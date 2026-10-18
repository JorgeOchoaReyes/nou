/**
 * A faster final stage for Ink's renderer. Every frame Ink lays the whole screen out as a grid of styled
 * cells and turns it back into a string. Ink 8 does that from scratch each time: a fresh cache per frame
 * (so every line of text on screen is re-tokenized), and a style diff between every pair of neighbouring
 * cells that builds three Sets each, about 30,000 throwaway objects for a 200x50 terminal. That was most of
 * the CPU time of every keystroke, scroll and streamed token.
 *
 * This installs a drop-in version of Ink's `Output` methods that produces exactly the same string (the
 * unit tests compare the two) but keeps its caches across frames and shares one array per distinct style,
 * so most neighbouring cells compare by reference and each style change is computed once. It only patches
 * the Ink version it was written against; anything else keeps Ink's own code.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

type Code = { type: string; code: string; endCode: string };
type Char = { type: "char"; value: string; fullWidth: boolean; styles: Code[] };
type Clip = { x1?: number | undefined; x2?: number | undefined; y1?: number | undefined; y2?: number | undefined };
type Operation =
  | { type: "write"; x: number; y: number; text: string; transformers: ((line: string, index: number) => string)[] }
  | { type: "clip"; clip: Clip }
  | { type: "unclip" };

type Tokenizer = {
  tokenize(text: string): unknown[];
  styledCharsFromTokens(tokens: unknown[]): Char[];
  ansiCodesToString(codes: Code[]): string;
  diffAnsiCodes(from: Code[], to: Code[]): Code[];
};

const PATCHED_VERSIONS = /^8\.0\./;
/** Plenty for every line on screen plus scrollback; cleared rather than evicted one by one. */
const MAX_CACHED = 20_000;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}+$/u;

export type FastOutput = {
  /** Ink's `Output.prototype` methods, so tests can compare against the original. */
  original: { get(this: unknown): { output: string; height: number } };
  patched: { get(this: unknown): { output: string; height: number } };
};

/** Builds the patched methods against Ink's own tokenizer and string-width. Exported for tests. */
export function makeFastOutput(tok: Tokenizer, stringWidth: (text: string) => number) {
  // One shared array per distinct style, so "same style" is a reference check.
  const interned = new Map<string, Code[]>();
  const NONE: Code[] = [];
  interned.set("", NONE);
  const intern = (styles: Code[]): Code[] => {
    if (styles.length === 0) return NONE;
    const key = styles.map((c) => `${c.code}\u0000${c.endCode}`).join("\u0001");
    let shared = interned.get(key);
    if (!shared) {
      shared = styles;
      interned.set(key, shared);
    }
    return shared;
  };

  // The escape codes to get from one style to another, computed once per pair.
  const transitions = new Map<Code[], Map<Code[], string>>();
  const transition = (from: Code[], to: Code[]): string => {
    if (from === to) return "";
    let row = transitions.get(from);
    if (!row) transitions.set(from, (row = new Map()));
    let codes = row.get(to);
    if (codes === undefined) {
      codes = from === NONE ? tok.ansiCodesToString(to) : tok.ansiCodesToString(tok.diffAnsiCodes(from, to));
      row.set(to, codes);
    }
    return codes;
  };

  /** Same result as ansi-tokenize's styledCharsToString, for interned styles. */
  const toString = (chars: Char[]): string => {
    let out = "";
    let prev = NONE;
    for (const char of chars) {
      if (char.styles !== prev) out += transition(prev, char.styles);
      out += char.value;
      prev = char.styles;
    }
    return out + transition(prev, NONE);
  };

  const styledChars = new Map<string, Char[]>();
  const getStyledChars = (line: string): Char[] => {
    let cached = styledChars.get(line);
    if (cached === undefined) {
      if (styledChars.size > MAX_CACHED) styledChars.clear();
      cached = tok.styledCharsFromTokens(tok.tokenize(line))
        .filter((c) => !IGNORABLE.test(c.value))
        .map((c) => ({ ...c, styles: intern(c.styles) }));
      styledChars.set(line, cached);
    }
    return cached;
  };
  // A write's text split at newlines and re-serialized per line, as Ink does before clipping.
  const splitLines = new Map<string, string[]>();
  const linesOf = (text: string): string[] => {
    let cached = splitLines.get(text);
    if (cached === undefined) {
      if (splitLines.size > MAX_CACHED) splitLines.clear();
      const rows: Char[][] = [[]];
      for (const c of getStyledChars(text)) {
        if (c.value === "\n") rows.push([]);
        else rows[rows.length - 1]!.push(c);
      }
      cached = rows.map(toString);
      splitLines.set(text, cached);
    }
    return cached;
  };
  const widths = new Map<string, number>();
  const width = (text: string): number => {
    let cached = widths.get(text);
    if (cached === undefined) {
      if (widths.size > MAX_CACHED) widths.clear();
      cached = stringWidth(text);
      widths.set(text, cached);
    }
    return cached;
  };
  const widest = (text: string): number => {
    let max = 0;
    for (const line of text.split("\n")) max = Math.max(max, width(line));
    return max;
  };

  const blank = (cell: Char): Char => ({ ...cell, value: " ", fullWidth: false });
  const EMPTY_CELL: Char = { type: "char", value: " ", fullWidth: false, styles: NONE };

  const slice = (line: string, from: number, to: number): string => {
    if (from >= to) return "";
    const result: Char[] = [];
    let column = 0;
    for (const c of getStyledChars(line)) {
      const w = width(c.value);
      const start = column;
      column += w;
      if (column <= from) continue;
      if (start >= to) break;
      result.push(w > 1 && (start < from || column > to) ? blank(c) : c);
    }
    return toString(result);
  };

  const isClipEmpty = (clip: Clip) =>
    (clip.x1 !== undefined && clip.x2 !== undefined && clip.x1 >= clip.x2) || (clip.y1 !== undefined && clip.y2 !== undefined && clip.y1 >= clip.y2);
  const bound = (a: number | undefined, b: number | undefined, tighter: (a: number, b: number) => number) =>
    a === undefined ? b : b === undefined ? a : tighter(a, b);
  const intersect = (outer: Clip | undefined, inner: Clip): Clip =>
    outer
      ? { x1: bound(outer.x1, inner.x1, Math.max), x2: bound(outer.x2, inner.x2, Math.min), y1: bound(outer.y1, inner.y1, Math.max), y2: bound(outer.y2, inner.y2, Math.min) }
      : inner;

  /** Ink's applyWriteOperation, with shared caches. */
  const apply = (output: Char[][], operation: Extract<Operation, { type: "write" }>, clip: Clip | undefined) => {
    const { text, transformers } = operation;
    let { x, y } = operation;
    let lines = linesOf(text);
    if (clip) {
      if (isClipEmpty(clip)) return;
      const clipX = typeof clip.x1 === "number" && typeof clip.x2 === "number";
      const clipY = typeof clip.y1 === "number" && typeof clip.y2 === "number";
      if (clipX && (x + widest(text) < clip.x1! || x > clip.x2!)) return;
      if (clipY && (y + lines.length < clip.y1! || y > clip.y2!)) return;
      if (clipX) {
        lines = lines.map((line) => {
          const from = x < clip.x1! ? clip.x1! - x : 0;
          const w = width(line);
          return slice(line, from, x + w > clip.x2! ? clip.x2! - x : w);
        });
        if (x < clip.x1!) x = clip.x1!;
      }
      if (clipY) {
        const from = y < clip.y1! ? clip.y1! - y : 0;
        const to = y + lines.length > clip.y2! ? clip.y2! - y : lines.length;
        lines = lines.slice(from, to);
        if (y < clip.y1!) y = clip.y1!;
      }
    }
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index]!;
      const row = output[y + index];
      if (!row) continue;
      for (const transformer of transformers) line = transformer(line, index + y - operation.y);
      const chars = getStyledChars(line);
      if (chars.length === 0) continue;
      let offsetX = x;
      if (row[offsetX]?.value === "" && offsetX > 0 && width(row[offsetX - 1]?.value ?? "") > 1) row[offsetX - 1] = blank(row[offsetX - 1]!);
      for (const c of chars) {
        row[offsetX] = c;
        const w = Math.max(1, width(c.value));
        for (let offset = 1; offset < w; offset++) {
          row[offsetX + offset] = { type: "char", value: offsetX < 0 ? " " : "", fullWidth: false, styles: c.styles };
        }
        offsetX += w;
      }
      if (row[offsetX]?.value === "") row[offsetX] = blank(row[offsetX]!);
    }
  };

  function get(this: { width: number; height: number; operations: Operation[] }) {
    const output: Char[][] = [];
    for (let y = 0; y < this.height; y++) output.push(new Array<Char>(this.width).fill(EMPTY_CELL));
    const clips: Clip[] = [];
    for (const operation of this.operations) {
      if (operation.type === "clip") clips.push(intersect(clips[clips.length - 1], operation.clip));
      else if (operation.type === "unclip") clips.pop();
      else apply(output, operation, clips[clips.length - 1]);
    }
    return {
      output: output.map((row) => toString(row.filter((c) => c !== undefined)).trimEnd()).join("\n"),
      height: output.length,
    };
  }
  return { get };
}

let installed: Promise<boolean> | null = null;

/** Finds a package the way Node would from `fromDir` (nested node_modules first) and returns its ESM entry. */
function resolveFrom(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", name);
    if (existsSync(path.join(pkgDir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
      const root = typeof pkg.exports === "object" && pkg.exports !== null ? pkg.exports["."] ?? pkg.exports : pkg.exports;
      const entry = typeof root === "string" ? root : root?.import ?? root?.default ?? pkg.module ?? pkg.main ?? "index.js";
      return pathToFileURL(path.join(pkgDir, typeof entry === "string" ? entry : entry.default)).href;
    }
    if (path.dirname(dir) === dir) throw new Error(`can't find ${name}`);
  }
}

/** Loads the modules Ink itself uses (they may be nested under Ink, so resolve from there). */
async function inkModules() {
  const inkUrl = import.meta.resolve("ink");
  const inkDir = path.dirname(path.dirname(fileURLToPath(inkUrl)));
  const version: string = JSON.parse(readFileSync(path.join(inkDir, "package.json"), "utf-8")).version;
  const load = (name: string) => import(resolveFrom(inkDir, name));
  const [output, tokenizer, stringWidth] = await Promise.all([import(new URL("./output.js", inkUrl).href), load("@alcalzone/ansi-tokenize"), load("string-width")]);
  return { version, Output: output.default, tokenizer: tokenizer as Tokenizer, stringWidth: stringWidth.default as (text: string) => number };
}

/** Swaps in the faster output stage. Returns whether it did (false: an Ink version it doesn't know). */
export function installFastOutput(): Promise<boolean> {
  installed ??= inkModules()
    .then(({ version, Output, tokenizer, stringWidth }) => {
      if (!PATCHED_VERSIONS.test(version) || typeof Output?.prototype?.get !== "function") return false;
      Output.prototype.get = makeFastOutput(tokenizer, stringWidth).get;
      return true;
    })
    .catch(() => false);
  return installed;
}

/** Ink's Output class and the modules it uses, for tests that compare both versions. */
export const loadInkOutput = inkModules;
