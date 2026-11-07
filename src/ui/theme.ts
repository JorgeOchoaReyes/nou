import path from "path";

/**
 * Tokyo Night inspired palette (truecolor; Windows Terminal supports it). Secondary text ("dim") is still at
 * least 4.5:1 against common dark backgrounds, so hints and help lines stay easy to read.
 */
const DARK = {
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
  text: "#c0caf5",
  dim: "#8b93c0",
  /** Lines around panes that aren't focused: quieter than text, since they aren't read. */
  border: "#565f89",
  panel: "#1f2335",
  /** Text on a colored badge (CHAT, CLOUD, EDITING...). */
  onBadge: "#1a1b26",
};

/** For terminals with a light background: the same roles, dark enough to read on white (4.5:1 or more). */
const LIGHT: typeof DARK = {
  accent: "#2e59c9",
  accent2: "#7341c2",
  cyan: "#007197",
  green: "#3b7a1e",
  yellow: "#8f5e00",
  orange: "#b4501b",
  red: "#c2264b",
  text: "#1f2335",
  dim: "#5a607a",
  border: "#a8aecb",
  panel: "#e6e7ed",
  onBadge: "#ffffff",
};

/** The colors in use: dark unless the terminal is light (see setPalette). Read at render time, so set it first. */
export const C = { ...DARK };

export type Palette = "dark" | "light";
let current: Palette = "dark";
export const palette = () => current;

/** Switches every color to the dark or light set. Call before the first render. */
export function setPalette(which: Palette) {
  current = which;
  Object.assign(C, which === "light" ? LIGHT : DARK);
  Object.assign(GIT_COLORS, gitColors());
  for (const [ext, color] of Object.entries(iconColors())) ICONS[ext]![1] = color;
}

/** Every spinner and shimmer ticks on this one interval, so they redraw together in a single frame. */
export const ANIMATION_MS = 100;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const gradientColors = () => current === "light"
  ? [C.accent, "#4b4fc4", C.accent2, "#8a3fb0", "#a8327f", C.red, C.orange, C.yellow, C.green, C.cyan]
  : [C.accent, "#8c9cf7", C.accent2, "#c39af2", "#e08ad6", C.red, C.orange, C.yellow, C.green, C.cyan];

/** Colors for each character of a label, shifted by `frame` so it shimmers when animated. */
export function gradient(text: string, frame = 0): { ch: string; color: string }[] {
  const colors = gradientColors();
  return [...text].map((ch, i) => ({ ch, color: colors[(i + frame) % colors.length]! }));
}

const gitColors = (): Record<string, string> => ({ M: C.yellow, A: C.green, "?": C.green, D: C.red, R: C.cyan, U: C.orange });
export const GIT_COLORS: Record<string, string> = gitColors();

/** Each file type's icon color: language colors, with JavaScript's yellow darkened on a light background. */
const iconColors = (): Record<string, string> => {
  const js = current === "light" ? "#8a7400" : "#f1e05a";
  return {
    ".ts": "#3178c6", ".tsx": C.cyan, ".mts": "#3178c6", ".cts": "#3178c6",
    ".js": js, ".jsx": C.cyan, ".mjs": js, ".cjs": js,
    ".py": "#3572a5", ".json": C.yellow, ".md": C.text, ".css": C.accent2,
    ".html": C.orange, ".yml": C.red, ".yaml": C.red, ".go": C.cyan,
    ".rs": C.orange, ".sh": C.green, ".ps1": C.accent, ".lock": C.dim,
  };
};
const ICON_SHAPES: Record<string, string> = {
  ".ts": "◆", ".tsx": "◆", ".mts": "◆", ".cts": "◆", ".js": "◆", ".jsx": "◆", ".mjs": "◆", ".cjs": "◆",
  ".py": "◆", ".json": "◇", ".md": "≡", ".css": "◆", ".html": "◆", ".yml": "◇", ".yaml": "◇", ".go": "◆",
  ".rs": "◆", ".sh": "$", ".ps1": "$", ".lock": "◌",
};
const ICONS: Record<string, [string, string]> = Object.fromEntries(Object.entries(iconColors()).map(([ext, color]) => [ext, [ICON_SHAPES[ext]!, color]]));

export function fileIcon(file: string): { icon: string; color: string } {
  const base = path.basename(file).toLowerCase();
  if (base.startsWith(".env")) return { icon: "⌁", color: C.yellow };
  if (base.startsWith(".git")) return { icon: "◌", color: C.orange };
  if (base === "package.json") return { icon: "⬢", color: C.green };
  const [icon, color] = ICONS[path.extname(base)] ?? ["•", C.dim];
  return { icon, color };
}
