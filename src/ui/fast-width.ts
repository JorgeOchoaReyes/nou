/**
 * A faster `string-width` for Ink. Ink measures every line of text on screen each frame (to wrap it, and
 * again to work out how much of a changed line it can leave on screen), and string-width splits each one
 * into graphemes and runs emoji regexes over them: a fifth of all rendering time, mostly spent on lines
 * of plain text and box-drawing characters whose width is simply their length.
 *
 * This answers those with one regex test, remembers the rest, and hands anything unusual to the real
 * string-width. Ink and its dependencies import string-width by name, so a module hook points that name
 * here; it has to be installed before Ink loads (index.ts does it first).
 */
// A namespace import: Node before 22.15 has no registerHooks, and a named import of it would fail to load.
import * as nodeModule from "module";

/**
 * Characters string-width counts as one column each and that never combine with what's next to them:
 * ASCII, Latin, Greek, Cyrillic, punctuation, arrows, math, box drawing and the symbols Nou's UI uses.
 * Emoji, combining marks and invisible characters are left out. The unit tests check every one.
 */
export const NARROW = /^[\u0020-\u007e\u00a0-\u00ac\u00ae-\u02ff\u0370-\u0482\u048a-\u04ff\u2010-\u2027\u202f-\u205e\u2190-\u2319\u231c-\u2328\u232b-\u23e8\u23ed-\u23ef\u23f1-\u23f2\u23f4-\u25fc\u25ff-\u2613\u2616-\u262f\u2638-\u2647\u2654-\u267e\u2680-\u2689\u2690-\u2692\u2694-\u26a0\u26a2-\u26a9\u26ac-\u26bc\u26bf-\u26c3\u26c6-\u26cd\u26cf-\u26d3\u26d5-\u26e9\u26eb-\u26f1\u26f4\u26f6-\u26f9\u26fb-\u26fc\u26fe-\u2704\u2706-\u2709\u270c-\u2727\u2729-\u274b\u274d\u274f-\u2752\u2756\u2758-\u2794\u2798-\u27af\u27b1-\u27be\u2b00-\u2b1a\u2b1d-\u2b4f\u2b51-\u2b54\u2b56-\u2bff]*$/;
/** Plenty for every line on screen and in scrollback; cleared rather than evicted one by one. */
const MAX_CACHED = 20_000;

type Options = { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean };
type StringWidth = (text: string, options?: Options) => number;

/** Wraps a string-width function with the fast path and a cache. Same answers, exported for tests. */
export function fastStringWidth(real: StringWidth): StringWidth {
  const cache = new Map<string, number>();
  return (text, options) => {
    if (options && (options.ambiguousIsNarrow === false || options.countAnsiEscapeCodes)) return real(text, options);
    if (typeof text !== "string") return real(text, options);
    if (NARROW.test(text)) return text.length;
    let width = cache.get(text);
    if (width === undefined) {
      if (cache.size > MAX_CACHED) cache.clear();
      width = real(text, options);
      cache.set(text, width);
    }
    return width;
  };
}

let installed = false;

/** Points every `import "string-width"` that loads from now on at the fast version. Returns whether it could. */
export function installFastWidth(): boolean {
  if (installed) return true;
  // registerHooks runs in-thread and synchronously (Node 22.15+); older versions keep the original.
  const { registerHooks } = nodeModule as Partial<typeof nodeModule>;
  if (typeof registerHooks !== "function" || process.env.NOU_NO_FAST_WIDTH) return false;
  const shim = new URL(`./width-shim${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (specifier !== "string-width" || context.parentURL?.startsWith(shim)) return resolved;
      // Each copy of string-width (Ink may have its own) gets its own wrapper.
      return { ...resolved, url: `${shim}?of=${encodeURIComponent(resolved.url)}` };
    },
  });
  installed = true;
  return true;
}
