/**
 * Renders Nou's UI with sample data and saves it as docs/screenshot.svg for the README.
 * Run: npm run screenshot
 */
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { renderToString, Box, Text } from "ink";
import { Header } from "../src/ui/Header.js";
import { FileTree } from "../src/ui/FileTree.js";
import { CodeView } from "../src/ui/CodeView.js";
import { Chat } from "../src/ui/Chat.js";
import { C } from "../src/ui/theme.js";
import type { ChatEntry } from "../src/agent/index.js";

const COLS = 150;
const ROWS = 34;

// A believable proposed edit to a real file in this repo.
const file = "src/commands/index.ts";
const before = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
const after = before.replace(
  `function resolveInProject(filePath: string): string {
  const fullPath = path.resolve(process.cwd(), filePath);
  const rel = path.relative(process.cwd(), fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(\`\${filePath} is outside the project folder\`);
  }
  return fullPath;
}`,
  `/** Resolves a path and refuses anything outside the project (including via symlinks). */
function resolveInProject(filePath: string): string {
  const root = realpathSync(process.cwd());
  const fullPath = path.resolve(root, filePath);
  const rel = path.relative(root, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(\`Refusing to touch \${filePath}: it is outside \${root}\`);
  }
  return fullPath;
}`,
).replace('import { readdirSync } from "fs";', 'import { readdirSync, realpathSync } from "fs";');

const entries: ChatEntry[] = [
  { kind: "user", text: "harden resolveInProject against symlinks" },
  { kind: "tool", text: "Read src/commands/index.ts" },
  { kind: "tool", text: "git: git_diff src/commands" },
  { kind: "assistant", text: "A symlink inside the project could point outside it. I'll resolve the real project root first, so writes can't escape it, and make the error name the root." },
];

const git = new Map([
  ["src/commands/index.ts", "M"],
  ["src/ui/Editor.tsx", "?"],
  ["README.md", "M"],
]);

const height = ROWS - 2;
const tree = 30;
const chat = 46;
const code = COLS - tree - chat;

const ansi = renderToString(
  <Box flexDirection="column" width={COLS}>
    <Header width={COLS} branch="master" changes={git.size} model="anthropic:claude-opus-5-5" local={false} busy={null} update={null} />
    <Box flexDirection="row">
      <FileTree width={tree} height={height} focused={false} openFile={file} reveal={file} version={0} changed={new Set()} git={git} problemCounts={new Map([["src/ui/Editor.tsx", { errors: 0, warnings: 2 }], ["index.ts", { errors: 1, warnings: 0 }]])} onOpen={() => {}} onHover={() => {}} />
      <CodeView width={code} height={height} focused={false} filePath={file} content={before}
        diff={{ path: file, before, after, isNew: false }} diffLabel="" pending={true} marked={new Set()} problems={[]} focusLine={null} syntaxVersion={0} diffNote="✓ no new problems" onViewport={() => {}} />
      <Chat width={chat} height={height} focused={true} entries={entries} streaming="" busy={null}
        approval={{ kind: "change", change: { path: file, before, after, isNew: false } }} contextChip={`${file}:15-22`} onSubmit={() => {}} onAnswer={() => {}} />
    </Box>
    <Text>
      <Text backgroundColor={C.yellow} color="black" bold> APPROVE </Text>
      <Text backgroundColor={C.panel} color={C.green}> ◉ follow </Text>
      <Text backgroundColor={C.panel} color={C.red}> ✖ 1</Text>
      <Text backgroundColor={C.panel} color={C.yellow}> ▲ 2 </Text>
      <Text color={C.dim}>  y accept · n reject · Esc stop</Text>
    </Text>
  </Box>,
  { columns: COLS },
);

// --- ANSI -> SVG -------------------------------------------------------------

const PALETTE_16 = [
  "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
  "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
];
const DEFAULT_FG = "#c0caf5";
const BG = "#1a1b26";

function xterm256(n: number): string {
  if (n < 16) return PALETTE_16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

type Style = { fg?: string | undefined; bg?: string | undefined; bold?: boolean; dim?: boolean; inverse?: boolean };
type Cell = { ch: string; style: Style };

function parse(text: string): Cell[][] {
  const lines: Cell[][] = [[]];
  let style: Style = {};
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      const codes = text.slice(i + 2, end).split(";").map((c) => Number(c || 0));
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k]!;
        if (c === 0) style = {};
        else if (c === 1) style = { ...style, bold: true };
        else if (c === 2) style = { ...style, dim: true };
        else if (c === 22) style = { ...style, bold: false, dim: false };
        else if (c === 7) style = { ...style, inverse: true };
        else if (c === 27) style = { ...style, inverse: false };
        else if (c === 39) style = { ...style, fg: undefined };
        else if (c === 49) style = { ...style, bg: undefined };
        else if (c >= 30 && c <= 37) style = { ...style, fg: PALETTE_16[c - 30] };
        else if (c >= 90 && c <= 97) style = { ...style, fg: PALETTE_16[c - 90 + 8] };
        else if (c >= 40 && c <= 47) style = { ...style, bg: PALETTE_16[c - 40] };
        else if (c >= 100 && c <= 107) style = { ...style, bg: PALETTE_16[c - 100 + 8] };
        else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
          const color = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
          style = c === 38 ? { ...style, fg: color } : { ...style, bg: color };
          k += 4;
        } else if ((c === 38 || c === 48) && codes[k + 1] === 5) {
          const color = xterm256(codes[k + 2]!);
          style = c === 38 ? { ...style, fg: color } : { ...style, bg: color };
          k += 2;
        }
      }
      i = end;
    } else if (ch === "\n") {
      lines.push([]);
    } else {
      const cp = text.codePointAt(i)!;
      const char = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      lines[lines.length - 1]!.push({ ch: char, style });
    }
  }
  return lines;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CW = 8.6;
const LH = 18;
const PAD_X = 18;
const TOP = 44;
const cells = parse(ansi);
const width = Math.ceil(COLS * CW + PAD_X * 2);
const svgHeight = TOP + cells.length * LH + 18;

const parts: string[] = [];
cells.forEach((line, row) => {
  const y = TOP + row * LH;
  // Merge runs of identical style.
  let col = 0;
  while (col < line.length) {
    const start = col;
    const s = line[col]!.style;
    let text = "";
    while (col < line.length && JSON.stringify(line[col]!.style) === JSON.stringify(s)) text += line[col++]!.ch;
    const fg = s.inverse ? s.bg ?? BG : s.fg ?? DEFAULT_FG;
    const bg = s.inverse ? s.fg ?? DEFAULT_FG : s.bg;
    const x = PAD_X + start * CW;
    const w = (col - start) * CW;
    if (bg) parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${(w + 0.5).toFixed(1)}" height="${LH}" fill="${bg}"/>`);
    // Only stretch the visible characters; SVG collapses edge spaces, so trim them and keep inner ones as nbsp.
    const lead = text.length - text.trimStart().length;
    const core = text.trim();
    if (core) {
      parts.push(
        `<text x="${(x + lead * CW).toFixed(1)}" y="${y + 13.5}" fill="${fg}"${s.bold ? " font-weight=\"bold\"" : ""}${s.dim ? " opacity=\"0.6\"" : ""} textLength="${([...core].length * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(core).replace(/ /g, " ")}</text>`,
      );
    }
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight}" viewBox="0 0 ${width} ${svgHeight}">
  <rect width="100%" height="100%" rx="12" fill="${BG}"/>
  <circle cx="22" cy="20" r="6" fill="#f7768e"/><circle cx="42" cy="20" r="6" fill="#e0af68"/><circle cx="62" cy="20" r="6" fill="#9ece6a"/>
  <text x="${width / 2}" y="25" fill="#565f89" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" text-anchor="middle">nou — ~/projects/nou</text>
  <g font-family="'Cascadia Mono', 'Cascadia Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14" xml:space="preserve">
    ${parts.join("\n    ")}
  </g>
</svg>
`;

mkdirSync("docs", { recursive: true });
writeFileSync("docs/screenshot.svg", svg);
console.log(`docs/screenshot.svg written (${cells.length} rows, ${(svg.length / 1024).toFixed(0)} kB)`);
