export type Severity = "error" | "warning" | "info";

/** One problem in a file. Lines and columns are 1-based. */
export type Diagnostic = {
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  severity: Severity;
  message: string;
  /** Which checker reported it, e.g. "eslint", "tsc". */
  source: string;
  /** Rule or error code, e.g. "no-undef", "TS2304". */
  code?: string;
};

/**
 * A checker (linter, type checker, language server...). Built-in checkers and plugins both use this.
 */
export type DiagnosticsProvider = {
  id: string;
  name: string;
  /** Can check text that isn't saved yet (used to check Nou's proposed edits before they're applied). */
  checksText: boolean;
  /** Checks the whole project at once (like `tsc`); `check` then returns problems for every file. */
  projectWide?: boolean;
  matches(file: string): boolean;
  /** Whether the tool is installed / configured for this project. */
  available(): boolean | Promise<boolean>;
  check(file: string, text: string): Promise<Diagnostic[]>;
};
