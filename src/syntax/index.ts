import { existsSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { Language, Parser, type Node } from "web-tree-sitter";
import { themeColors, type Role } from "./themes.js";
import type { Diagnostic, DiagnosticsProvider } from "../diagnostics/types.js";

/** File extension -> grammar name (tree-sitter-<name>.wasm). Only these are shipped with Nou. */
const GRAMMARS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python", ".json": "json", ".css": "css", ".html": "html", ".htm": "html",
  ".sh": "bash", ".bash": "bash", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
};
export const SHIPPED_GRAMMARS = [...new Set(Object.values(GRAMMARS))];

const here = path.dirname(fileURLToPath(import.meta.url));

/** Shipped builds keep grammars in dist/grammars; from source they come from the dev dependency. */
function grammarDir(): string | null {
  const candidates = [path.join(here, "..", "..", "grammars"), path.join(here, "..", "..", "..", "grammars")];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out"));
  } catch {
    // not installed (normal for published builds)
  }
  return candidates.find((dir) => existsSync(path.join(dir, "tree-sitter-json.wasm"))) ?? null;
}

let init: Promise<void> | null = null;
const languages = new Map<string, Language | "loading" | "failed">();
let parser: Parser | null = null;
const listeners = new Set<() => void>();

/** Tells views to re-highlight (a grammar or the fallback highlighter just loaded). */
export function notifySyntaxLoaded() {
  for (const l of listeners) l();
}

/** Called when a grammar finishes loading, so views can re-highlight. */
export function onGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function grammarFor(file: string): string | undefined {
  return GRAMMARS[path.extname(file).toLowerCase()];
}

function load(name: string) {
  if (languages.has(name)) return;
  languages.set(name, "loading");
  init ??= Parser.init().then(() => {
    parser = new Parser();
  });
  void init
    .then(async () => {
      const dir = grammarDir();
      if (!dir) throw new Error("grammars not found");
      languages.set(name, await Language.load(path.join(dir, `tree-sitter-${name}.wasm`)));
      notifySyntaxLoaded();
    })
    .catch(() => languages.set(name, "failed"));
}

/** Parses the file if its grammar is ready; otherwise starts loading it and returns null. */
function parse(file: string, text: string) {
  const name = grammarFor(file);
  if (!name) return null;
  const lang = languages.get(name);
  if (!lang) load(name);
  if (!lang || typeof lang === "string" || !parser) return null;
  try {
    parser.setLanguage(lang);
    return parser.parse(text);
  } catch {
    // Some shipped grammars call into the runtime with functions it doesn't have (e.g. YAML's scanner).
    // Don't use that grammar again; callers fall back to highlight.js.
    languages.set(name, "failed");
    parser = new Parser();
    return null;
  }
}

export function hasGrammar(file: string): boolean {
  return grammarFor(file) !== undefined;
}

/** Starts loading a file's grammar ahead of time. */
export function preload(file: string) {
  const name = grammarFor(file);
  if (name) load(name);
}

// --- highlighting --------------------------------------------------------------

type Color = Role;

const STRINGS = /^(string|template_string|string_fragment|string_content|raw_string_literal|interpreted_string_literal|char_literal|character_literal|escape_sequence|string_literal|heredoc_body)$/;
const NUMBERS = /^(number|integer|float|integer_literal|float_literal|number_literal|decimal_integer_literal|decimal_floating_point_literal)$/;
const TYPES = /^(type_identifier|predefined_type|primitive_type|builtin_type|type)$/;
const PROPERTIES = /^(property_identifier|field_identifier|shorthand_property_identifier|shorthand_property_identifier_pattern|property_name|key|bare_key)$/;
const CONSTANTS = /^(true|false|null|undefined|none|nil|this|self|super|True|False|None|boolean)$/;
const FUNCTION_PARENTS = /^(function_declaration|function_definition|method_definition|function_item|method_declaration|function_signature|generator_function_declaration)$/;
const CALLS = /^(call_expression|call|method_invocation|new_expression)$/;

/** A named string node (anonymous keyword nodes can also be called "string", e.g. the TS type). */
const isString = (n: Node) => n.isNamed && STRINGS.test(n.type);
const hasSubstitution = (n: Node) => n.children.some((c) => c !== null && /substitution|interpolation/.test(c.type));

function colorFor(node: Node): Color | null {
  const type = node.type;
  if (type.includes("comment")) return "comment";
  // Inside a string (but not inside ${...} substitutions)?
  for (let p: Node | null = node; p; p = p.parent) {
    if (/substitution|interpolation/.test(p.type)) break;
    if (isString(p)) return "string";
  }
  // Built-in type names (`number`, `string`) and Python annotations (`name: str`).
  if (node.parent?.type === "predefined_type" || (node.parent?.type === "type" && /identifier$/.test(type))) return "type";
  if (NUMBERS.test(type)) return "number";
  if (CONSTANTS.test(type) || CONSTANTS.test(node.text)) return node.isNamed || /^[a-zA-Z]+$/.test(node.text) ? "constant" : null;
  if (TYPES.test(type) && (node.isNamed || node.parent?.type === "predefined_type")) return "type";
  if (/identifier$/.test(type)) {
    const parent = node.parent;
    if (parent && FUNCTION_PARENTS.test(parent.type) && parent.childForFieldName("name")?.equals(node)) return "func";
    if (parent && CALLS.test(parent.type) && parent.childForFieldName("function")?.equals(node)) return "func";
    // obj.method(): only the method name, not the object.
    const member = parent && /member_expression|attribute|field_expression|selector_expression/.test(parent.type)
      ? parent.childForFieldName("property") ?? parent.childForFieldName("attribute") ?? parent.childForFieldName("field")
      : null;
    if (member?.equals(node) && parent!.parent && CALLS.test(parent!.parent.type) && parent!.parent.childForFieldName("function")?.equals(parent!)) return "func";
  }
  if (PROPERTIES.test(type)) return "property";
  if (/tag_name|jsx_opening_element|jsx_closing_element/.test(type)) return "tag";
  if (type === "identifier") {
    if (/^[A-Z][A-Z0-9_]+$/.test(node.text)) return "constant";
    if (/^[A-Z]/.test(node.text)) return "type";
    return null;
  }
  if (!node.isNamed) {
    if (node.parent?.type === "predefined_type") return "type";
    return /^[a-z_]+$/i.test(type) ? "keyword" : "punctuation";
  }
  return null;
}

/** Syntax-highlights `text` with tree-sitter, one ANSI string per line; null if the grammar isn't ready. */
export function highlightTree(file: string, text: string): string[] | null {
  if (text.length > 300_000) return null;
  const tree = parse(file, text);
  if (!tree) return null;
  let out = "";
  let pos = 0;
  const cursor = tree.walk();
  // Depth-first over leaves, coloring each span.
  const visit = (): void => {
    do {
      const node = cursor.currentNode;
      if (node.childCount === 0 || node.type.includes("comment") || (isString(node) && !hasSubstitution(node))) {
        if (node.startIndex >= pos) {
          out += themeColors().plain(text.slice(pos, node.startIndex));
          const color = colorFor(node);
          const span = text.slice(node.startIndex, node.endIndex);
          // Color each line separately so styles don't bleed across line breaks.
          out += span.split("\n").map((part) => (color ? themeColors()[color](part) : themeColors().plain(part))).join("\n");
          pos = node.endIndex;
        }
      } else if (cursor.gotoFirstChild()) {
        visit();
        cursor.gotoParent();
      }
    } while (cursor.gotoNextSibling());
  };
  if (cursor.gotoFirstChild()) visit();
  out += themeColors().plain(text.slice(pos));
  tree.delete();
  return out.split("\n");
}

// --- syntax errors -------------------------------------------------------------

/** Syntax errors straight from the parser: instant, and works without any linter installed. */
export const syntaxProvider: DiagnosticsProvider = {
  id: "syntax",
  name: "Syntax",
  checksText: true,
  matches: hasGrammar,
  available: () => grammarDir() !== null,
  async check(file, text) {
    preload(file);
    await init;
    // Wait briefly for the grammar on first use.
    for (let i = 0; i < 50 && languages.get(grammarFor(file)!) === "loading"; i++) await new Promise((r) => setTimeout(r, 20));
    const tree = parse(file, text);
    if (!tree || !tree.rootNode.hasError) {
      tree?.delete();
      return [];
    }
    const found: Diagnostic[] = [];
    const rel = path.relative(process.cwd(), path.resolve(process.cwd(), file)).replace(/\\/g, "/");
    const visit = (node: Node) => {
      if (found.length >= 20) return;
      if (node.type === "ERROR" || node.isMissing) {
        const snippet = node.text.split("\n")[0]!.slice(0, 30);
        found.push({
          file: rel,
          line: node.startPosition.row + 1,
          col: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column + 1,
          severity: "error",
          message: node.isMissing ? `Syntax error: missing "${node.type}"` : `Syntax error near ${JSON.stringify(snippet)}`,
          source: "syntax",
        });
        if (node.type === "ERROR") return; // don't report nested errors twice
      }
      if (node.hasError) for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    tree.delete();
    return found;
  },
};
