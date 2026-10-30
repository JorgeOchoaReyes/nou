import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { projectFiles } from "../search/index.js";

/**
 * Go to definition without a language server: good enough for Ctrl+click in most code. A name that was
 * imported goes to its import line (where a click on the path opens that file); anything else goes to
 * where the file, or failing that the project, declares it.
 */
export type Target = { file: string; line: number; col?: number };

const IDENT = /[A-Za-z_$][\w$]*/g;
/** Lines that bring names in from another file, with the module path as group 1 (or 2 for Python's from). */
const IMPORT_LINE = /^\s*(?:import\b.*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|export\b.*?from\s+["']([^"']+)["']|.*\brequire\(\s*["']([^"']+)["']\s*\)|from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/;
const STRING = /(["'`])((?:\\.|(?!\1).)*)\1/g;

/** The identifier at column `col` (1-based) of a line, if any. */
export function wordAt(text: string, col: number): { word: string; start: number } | null {
  for (const m of text.matchAll(IDENT)) {
    if (col - 1 >= m.index && col - 1 < m.index + m[0].length) return { word: m[0], start: m.index + 1 };
  }
  return null;
}

/** The module an import line names, e.g. "./b.js" or "pkg.mod". */
function importedModule(line: string): string | null {
  const m = line.match(IMPORT_LINE);
  return m ? m.slice(1).find((g) => g) ?? null : null;
}

/** The file a module path resolves to from `fromFile`: relative imports and Python modules in the project. */
export function resolveModule(fromFile: string, spec: string): string | null {
  const dir = path.dirname(fromFile);
  const candidates: string[] = [];
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = path.join(dir, spec);
    // TypeScript imports name the .js the .ts compiles to.
    const stripped = base.replace(/\.(m|c)?js$/, "");
    for (const b of [base, stripped]) {
      candidates.push(b);
      for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"]) candidates.push(b + ext);
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py"]) candidates.push(path.join(b, `index${ext}`));
    }
    if (spec.startsWith(".") && /^\.+[\w.]/.test(spec) && fromFile.endsWith(".py")) {
      // Python relative: from .mod import x / from ..pkg.mod import x
      const dots = spec.match(/^\.+/)![0].length;
      const up = path.join(dir, ...Array<string>(dots - 1).fill(".."), ...spec.slice(dots).split("."));
      candidates.push(`${up}.py`, path.join(up, "__init__.py"));
    }
  } else if (/^[\w.]+$/.test(spec)) {
    const parts = spec.split(".");
    for (const root of [".", "src", dir]) candidates.push(path.join(root, ...parts) + ".py", path.join(root, ...parts, "__init__.py"));
  }
  const found = candidates.find((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
  return found ? path.normalize(found).replace(/\\/g, "/") : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines that declare `name`, most specific first. */
function declares(name: string): RegExp {
  const n = escape(name);
  return new RegExp(
    "^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:" +
      `function\\*?\\s+${n}\\b|(?:abstract\\s+)?class\\s+${n}\\b|interface\\s+${n}\\b|type\\s+${n}\\b|enum\\s+${n}\\b|` +
      `(?:const|let|var)\\s+${n}\\b|(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=|def\\s+${n}\\b|class\\s+${n}\\b|func\\s+(?:\\([^)]*\\)\\s*)?${n}\\b|fn\\s+${n}\\b|${n}\\s*=[^=])` +
      `|^\\s*(?:public|private|protected|static|readonly|async|\\s)*${n}\\s*\\([^)]*\\)\\s*(?::[^{;]*)?\\{`,
  );
}

function declarationIn(lines: string[], name: string, skip = -1): number {
  const re = declares(name);
  return lines.findIndex((l, i) => i !== skip && re.test(l));
}

function readLines(file: string): string[] | null {
  try {
    const text = readFileSync(file, "utf-8");
    return text.length > 2_000_000 ? null : text.split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Where to go for a Ctrl+click at `line`:`col` (1-based) in `file`, whose current text is `text`. */
export function findDefinition(file: string, text: string, line: number, col: number): Target | null {
  const lines = text.split(/\r?\n/);
  const here = lines[line - 1] ?? "";
  const spec = importedModule(here);

  // On the path of an import: open that file.
  if (spec) {
    for (const m of here.matchAll(STRING)) {
      if (col - 1 >= m.index && col - 1 < m.index + m[0].length) {
        const target = resolveModule(file, m[2]!);
        return target ? { file: target, line: 1 } : null;
      }
    }
  }
  const at = wordAt(here, col);
  if (!at) return null;
  const { word } = at;

  // On a name in an import line: where that file declares it (or just the file).
  if (spec) {
    const target = resolveModule(file, spec);
    if (!target) return null;
    const theirs = readLines(target);
    const index = theirs ? declarationIn(theirs, word) : -1;
    return { file: target, line: index + 1 || 1 };
  }

  // Imported here: its import line, where the path is a click away.
  const importLine = lines.findIndex((l) => importedModule(l) && new RegExp(`\\b${escape(word)}\\b`).test(l.replace(STRING, "")));
  if (importLine >= 0 && importLine !== line - 1) return { file, line: importLine + 1, col: lines[importLine]!.search(new RegExp(`\\b${escape(word)}\\b`)) + 1 };

  // Declared in this file.
  const local = declarationIn(lines, word, line - 1);
  if (local >= 0) return { file, line: local + 1 };

  // Declared somewhere else in the project.
  const ext = path.extname(file);
  // A click waits on this, so it reads at most a few megabytes before giving up.
  const files = projectFiles().filter((f) => f !== file && path.extname(f) === ext).slice(0, 3000);
  let budget = 8_000_000;
  for (const other of files) {
    if (!existsSync(other) || budget <= 0) continue;
    const size = statSync(other).size;
    if (size > 1_000_000) continue;
    budget -= size;
    const theirs = readLines(other);
    if (!theirs) continue;
    const index = declarationIn(theirs, word);
    if (index >= 0) return { file: other, line: index + 1 };
  }
  return null;
}
