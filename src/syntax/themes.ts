import chalk, { type ChalkInstance } from "chalk";
import type { CodeTheme } from "../config/index.js";

/** What gets its own color in code. */
export type Role = "keyword" | "string" | "number" | "comment" | "type" | "func" | "property" | "constant" | "tag" | "punctuation" | "plain";

type Palette = Record<Role, string>;

/** Well-known editor themes; one-dark is the default because it reads well on most dark terminals. */
const PALETTES: Record<CodeTheme, Palette> = {
  "one-dark": {
    keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#7f848e", type: "#e5c07b", func: "#61afef",
    property: "#e06c75", constant: "#d19a66", tag: "#e06c75", punctuation: "#abb2bf", plain: "#d7dae0",
  },
  "tokyo-night": {
    keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#737aa2", type: "#2ac3de", func: "#7aa2f7",
    property: "#73daca", constant: "#ff9e64", tag: "#f7768e", punctuation: "#89ddff", plain: "#c0caf5",
  },
  "github-dark": {
    keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", type: "#ffa657", func: "#d2a8ff",
    property: "#79c0ff", constant: "#79c0ff", tag: "#7ee787", punctuation: "#c9d1d9", plain: "#e6edf3",
  },
  dracula: {
    keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#8a94c4", type: "#8be9fd", func: "#50fa7b",
    property: "#66d9ef", constant: "#bd93f9", tag: "#ff79c6", punctuation: "#f8f8f2", plain: "#f8f8f2",
  },
  "high-contrast": {
    keyword: "#ff9cf5", string: "#a6ff8f", number: "#ffd27f", comment: "#b0b0b0", type: "#7fe7ff", func: "#8fc7ff",
    property: "#ffb38a", constant: "#ffd27f", tag: "#ff8a8a", punctuation: "#ffffff", plain: "#ffffff",
  },
  "github-light": {
    keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#6e7781", type: "#953800", func: "#8250df",
    property: "#0550ae", constant: "#0550ae", tag: "#116329", punctuation: "#24292f", plain: "#24292f",
  },
};

const paint = (palette: Palette): Record<Role, ChalkInstance> =>
  Object.fromEntries(Object.entries(palette).map(([role, hex]) => [role, role === "comment" ? chalk.hex(hex).italic : chalk.hex(hex)])) as Record<Role, ChalkInstance>;

let current: CodeTheme = "one-dark";
let colors = paint(PALETTES[current]);
let version = 0;

/** The chalk styles for the current theme. */
export const themeColors = () => colors;
/** Changes whenever the theme does, so cached highlighting can be redone. */
export const themeVersion = () => version;

export function setCodeTheme(theme: CodeTheme) {
  if (theme === current || !PALETTES[theme]) return;
  current = theme;
  colors = paint(PALETTES[theme]);
  version++;
}

/** The same colors for highlight.js (cli-highlight), used for languages tree-sitter doesn't cover. */
export function highlightJsTheme() {
  const c = colors;
  return {
    keyword: c.keyword, built_in: c.type, type: c.type, literal: c.constant, number: c.number, regexp: c.string,
    string: c.string, subst: c.plain, symbol: c.constant, class: c.type, function: c.func, title: c.func, params: c.plain,
    comment: c.comment, doctag: c.comment, meta: c.comment, "meta-keyword": c.keyword, "meta-string": c.string,
    section: c.func, tag: c.tag, name: c.tag, "builtin-name": c.type, attr: c.property, attribute: c.property,
    variable: c.plain, bullet: c.punctuation, code: c.string, emphasis: c.plain.italic, strong: c.plain.bold,
    formula: c.plain, link: c.func, quote: c.comment, "selector-tag": c.tag, "selector-id": c.func, "selector-class": c.func,
    "selector-attr": c.property, "selector-pseudo": c.property, "template-tag": c.keyword, "template-variable": c.plain,
    addition: c.string, deletion: c.tag, default: c.plain,
  };
}
