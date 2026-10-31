import path from "path";

/** Tokyo Night inspired palette (truecolor; Windows Terminal supports it). */
export const C = {
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
  text: "#c0caf5",
  dim: "#565f89",
  panel: "#1f2335",
} as const;

/** Every spinner and shimmer ticks on this one interval, so they redraw together in a single frame. */
export const ANIMATION_MS = 100;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GRADIENT = [C.accent, "#8c9cf7", C.accent2, "#c39af2", "#e08ad6", C.red, C.orange, C.yellow, C.green, C.cyan];

/** Colors for each character of a label, shifted by `frame` so it shimmers when animated. */
export function gradient(text: string, frame = 0): { ch: string; color: string }[] {
  return [...text].map((ch, i) => ({ ch, color: GRADIENT[(i + frame) % GRADIENT.length]! }));
}

export const GIT_COLORS: Record<string, string> = {
  M: C.yellow, A: C.green, "?": C.green, D: C.red, R: C.cyan, U: C.orange,
};

const ICONS: Record<string, [string, string]> = {
  ".ts": ["◆", "#3178c6"], ".tsx": ["◆", C.cyan], ".mts": ["◆", "#3178c6"], ".cts": ["◆", "#3178c6"],
  ".js": ["◆", "#f1e05a"], ".jsx": ["◆", C.cyan], ".mjs": ["◆", "#f1e05a"], ".cjs": ["◆", "#f1e05a"],
  ".py": ["◆", "#3572a5"], ".json": ["◇", C.yellow], ".md": ["≡", C.text], ".css": ["◆", C.accent2],
  ".html": ["◆", C.orange], ".yml": ["◇", C.red], ".yaml": ["◇", C.red], ".go": ["◆", C.cyan],
  ".rs": ["◆", C.orange], ".sh": ["$", C.green], ".ps1": ["$", C.accent], ".lock": ["◌", C.dim],
};

export function fileIcon(file: string): { icon: string; color: string } {
  const base = path.basename(file).toLowerCase();
  if (base.startsWith(".env")) return { icon: "⚿", color: C.yellow };
  if (base.startsWith(".git")) return { icon: "◌", color: C.orange };
  if (base === "package.json") return { icon: "⬢", color: C.green };
  const [icon, color] = ICONS[path.extname(base)] ?? ["•", C.dim];
  return { icon, color };
}
