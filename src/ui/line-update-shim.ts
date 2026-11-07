/**
 * Stands in for Ink's line-update (see fast-width.ts), which works out how much of a changed line can stay
 * on screen. For any line with a character outside plain ASCII (every line with a box border, so nearly all
 * of Nou's) it splits both versions into graphemes, every frame. Lines made only of one-column characters
 * that never combine (fast-width's NARROW) have one grapheme per character, so this answers those directly,
 * with exactly what Ink would, and hands every other line to Ink's own code.
 */
import { NARROW } from "./fast-width.js";

type LineUpdate = (previous: string, next: string, columns?: number) => string;

// eslint-disable-next-line no-control-regex -- SGR starts with ESC
const SGR = /\u001b\[[\d;]*m/gu;

/** Ink's lineUpdate with the fast path in front. Same answers; exported for tests. */
export function fastLineUpdate(real: LineUpdate): LineUpdate {
  return (previous, next, columns) => {
    if (columns === undefined || Number.isNaN(columns) || columns < 1) return real(previous, next, columns);
    let common = 0;
    while (common < previous.length && common < next.length && previous[common] === next[common]) common++;
    if (common === 0) return real(previous, next, columns);
    const previousText = previous.replaceAll(SGR, "");
    const nextText = next.replaceAll(SGR, "");
    // Controls are excluded by NARROW too (it starts at the space).
    if (!NARROW.test(previousText) || !NARROW.test(nextText)) return real(previous, next, columns);
    const codes = [...next.matchAll(SGR)];
    let textLimit = common;
    for (const match of codes) {
      if (match.index >= common) break;
      textLimit -= Math.min(match[0].length, common - match.index);
    }
    // One character a grapheme and a column, so this is the grapheme walk Ink does.
    let textLength = 0;
    while (textLength < textLimit && previousText[textLength] === nextText[textLength]) textLength++;
    const column = textLength;
    const full = `\u001b[1G\u001b[K${next}`;
    if (column === 0 || column >= columns || previousText.length > columns || nextText.length > columns) return full;
    let offset = textLength;
    let styles = "";
    for (const match of codes) {
      if (match.index > offset || match.index + match[0].length > common) break;
      offset += match[0].length;
      styles += match[0];
    }
    const partial = `\u001b[${column + 1}G\u001b[K${styles}${next.slice(offset)}`;
    return partial.length < full.length ? partial : full;
  };
}

const of = new URL(import.meta.url).searchParams.get("of");
const real: LineUpdate | null = of ? (await import(of)).default : null;
export default real ? fastLineUpdate(real) : null;
