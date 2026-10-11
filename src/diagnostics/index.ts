import { readFileSync } from "fs";
import path from "path";
import type { Diagnostic, DiagnosticsProvider, Severity } from "./types.js";

export type * from "./types.js";

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export const sortDiagnostics = (list: Diagnostic[]) =>
  [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || ORDER[a.severity] - ORDER[b.severity]);

export function formatDiagnostic(d: Diagnostic, withFile = false): string {
  return `${withFile ? `${d.file}:` : "line "}${d.line}:${d.col} ${d.severity}: ${d.message}${d.code ? ` (${d.source} ${d.code})` : ` (${d.source})`}`;
}

/** Problems in `after` that weren't in `before`, matched by checker + code + message (line numbers shift). */
export function newProblems(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const key = (d: Diagnostic) => `${d.source}|${d.code ?? ""}|${d.message}`;
  const seen = new Map<string, number>();
  for (const d of before) seen.set(key(d), (seen.get(key(d)) ?? 0) + 1);
  return after.filter((d) => {
    const left = seen.get(key(d)) ?? 0;
    if (left > 0) {
      seen.set(key(d), left - 1);
      return false;
    }
    return true;
  });
}

/** tsc and the TypeScript language server can report the same error; keep one. */
function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.file}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readText(file: string): string | null {
  try {
    return readFileSync(path.resolve(process.cwd(), file), "utf-8");
  } catch {
    return null;
  }
}

/** Runs checkers, caches their results per file, and tells the UI when anything changes. */
export class DiagnosticsManager {
  private providers: DiagnosticsProvider[] = [];
  private availability = new Map<string, boolean>();
  /** file -> provider id -> problems */
  private results = new Map<string, Map<string, Diagnostic[]>>();
  private projectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = new Set<string>();
  private listeners = new Set<() => void>();

  setProviders(providers: DiagnosticsProvider[]) {
    const ids = new Set(providers.map((p) => p.id));
    // Drop results from checkers that were switched off.
    for (const byProvider of this.results.values()) {
      for (const id of [...byProvider.keys()]) if (!ids.has(id)) byProvider.delete(id);
    }
    this.providers = providers;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Names of checkers currently running, for the status bar. */
  get busy(): string[] {
    return [...this.running];
  }

  private async isAvailable(p: DiagnosticsProvider): Promise<boolean> {
    if (!this.availability.has(p.id)) {
      try {
        this.availability.set(p.id, await p.available());
      } catch {
        this.availability.set(p.id, false);
      }
    }
    return this.availability.get(p.id)!;
  }

  async activeProviders(): Promise<DiagnosticsProvider[]> {
    const out: DiagnosticsProvider[] = [];
    for (const p of this.providers) if (await this.isAvailable(p)) out.push(p);
    return out;
  }

  private async runProvider(p: DiagnosticsProvider, file: string, text: string): Promise<Diagnostic[]> {
    this.running.add(p.name);
    this.emit();
    try {
      return await p.check(file, text);
    } catch {
      return [];
    } finally {
      this.running.delete(p.name);
      this.emit();
    }
  }

  private store(file: string, providerId: string, list: Diagnostic[]) {
    const byProvider = this.results.get(file) ?? new Map<string, Diagnostic[]>();
    byProvider.set(providerId, list);
    this.results.set(file, byProvider);
  }

  /** Checks one file (unsaved `text` if given, otherwise what's on disk) with the per-file checkers. */
  async checkFile(file: string, text?: string): Promise<Diagnostic[]> {
    const content = text ?? readText(file);
    if (content === null) return [];
    const providers = (await this.activeProviders()).filter((p) => !p.projectWide && p.matches(file));
    await Promise.all(providers.map(async (p) => this.store(file, p.id, await this.runProvider(p, file, content))));
    this.emit();
    return this.get(file);
  }

  /** Runs project-wide checkers (like tsc) and replaces their results everywhere. */
  async checkProject(): Promise<void> {
    const providers = (await this.activeProviders()).filter((p) => p.projectWide);
    await Promise.all(providers.map(async (p) => {
      const list = await this.runProvider(p, ".", "");
      for (const byProvider of this.results.values()) byProvider.delete(p.id);
      const byFile = new Map<string, Diagnostic[]>();
      for (const d of list) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
      for (const [file, items] of byFile) this.store(file, p.id, items);
    }));
    this.emit();
  }

  /** Debounced checkProject, for after saves. */
  scheduleProject(delay = 1500) {
    if (this.projectTimer) clearTimeout(this.projectTimer);
    this.projectTimer = setTimeout(() => void this.checkProject(), delay);
  }

  /** Checks text without storing it, e.g. a proposed edit. Only checkers that accept unsaved text. */
  async checkText(file: string, text: string): Promise<Diagnostic[]> {
    const providers = (await this.activeProviders()).filter((p) => p.checksText && !p.projectWide && p.matches(file));
    return (await Promise.all(providers.map((p) => this.runProvider(p, file, text)))).flat();
  }

  get(file: string): Diagnostic[] {
    return dedupe(sortDiagnostics([...(this.results.get(file)?.values() ?? [])].flat()));
  }

  all(): Diagnostic[] {
    return dedupe(sortDiagnostics([...this.results.values()].flatMap((m) => [...m.values()].flat())));
  }

  counts(file?: string): { errors: number; warnings: number } {
    const list = file ? this.get(file) : this.all();
    return {
      errors: list.filter((d) => d.severity === "error").length,
      warnings: list.filter((d) => d.severity === "warning").length,
    };
  }

  /** Per-file counts, for markers in the file tree. */
  fileCounts(): Map<string, { errors: number; warnings: number }> {
    const out = new Map<string, { errors: number; warnings: number }>();
    for (const d of this.all()) {
      const c = out.get(d.file) ?? { errors: 0, warnings: 0 };
      if (d.severity === "error") c.errors++;
      else if (d.severity === "warning") c.warnings++;
      out.set(d.file, c);
    }
    return out;
  }

  /**
   * After Nou's edit: the problems it introduced in that file, compared with the file before.
   * Checks both versions with per-file checkers, and re-runs project-wide ones.
   */
  async introducedBy(file: string, before: string, after: string): Promise<Diagnostic[]> {
    const projectIds = (await this.activeProviders()).filter((p) => p.projectWide && p.matches(file)).map((p) => p.id);
    const projectBefore = this.getFrom(file, projectIds);
    // One after the other: language servers hold a single copy of each document.
    const beforeList = await this.checkText(file, before);
    const afterList = await this.checkFile(file, after);
    if (projectIds.length) await this.checkProject();
    return [...newProblems(beforeList, afterList), ...newProblems(projectBefore, this.getFrom(file, projectIds))];
  }

  private getFrom(file: string, providerIds: string[]): Diagnostic[] {
    return providerIds.flatMap((id) => this.results.get(file)?.get(id) ?? []);
  }

}
