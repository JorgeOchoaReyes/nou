import path from "path";
import { highlight, supportsLanguage } from "cli-highlight";
import { diffLines } from "diff";
import { highlightTree } from "../syntax/index.js";

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".json": "json", ".md": "markdown", ".css": "css", ".html": "xml",
  ".sh": "bash", ".ps1": "powershell", ".yml": "yaml", ".yaml": "yaml", ".go": "go",
  ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp", ".cs": "csharp", ".sql": "sql",
};

/** Splits file text into display lines: normalizes CRLF and expands tabs. */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function highlightLines(filePath: string, text: string): string[] {
  const plain = splitLines(text);
  // tree-sitter when the grammar is loaded (accurate); highlight.js otherwise.
  const tree = highlightTree(filePath, plain.join("\n"));
  if (tree) return tree;
  const language = LANGUAGES[path.extname(filePath).toLowerCase()];
  if (!language || !supportsLanguage(language) || text.length > 200_000) return plain;
  try {
    return highlight(plain.join("\n"), { language, ignoreIllegals: true }).split("\n");
  } catch {
    return plain;
  }
}

/** Word-wraps plain text to the given width. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const max = Math.max(1, width);
  for (const raw of splitLines(text)) {
    if (raw.length <= max) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      if ((line + word).length <= max) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > max) {
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    out.push(line);
  }
  return out;
}

export type DiffCell = { n: number; text: string };
export type DiffRow = { left?: DiffCell; right?: DiffCell; changed: boolean };

/** Lines up before/after text into rows for a side by side diff. */
export function sideBySide(before: string, after: string): DiffRow[] {
  const parts = diffLines(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
  const rows: DiffRow[] = [];
  let ln = 1;
  let rn = 1;
  const cells = (value: string) => (value ? splitLines(value) : []);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of cells(part.value)) rows.push({ left: { n: ln++, text }, right: { n: rn++, text }, changed: false });
      continue;
    }
    const removed = part.removed ? cells(part.value) : [];
    let added = part.added ? cells(part.value) : [];
    if (part.removed && parts[i + 1]?.added) {
      added = cells(parts[++i]!.value);
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const row: DiffRow = { changed: true };
      if (k < removed.length) row.left = { n: ln++, text: removed[k]! };
      if (k < added.length) row.right = { n: rn++, text: added[k]! };
      rows.push(row);
    }
  }
  return rows;
}

/** 1-based line numbers in `after` that were added or changed. */
export function changedLines(before: string, after: string): Set<number> {
  const lines = new Set<number>();
  for (const row of sideBySide(before, after)) {
    if (row.changed && row.right) lines.add(row.right.n);
  }
  return lines;
}
