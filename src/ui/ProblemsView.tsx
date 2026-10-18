import { useEffect, useMemo, useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import type { Diagnostic } from "../diagnostics/index.js";
import { C, SPINNER, fileIcon } from "./theme.js";
import { Pane } from "./Pane.js";
import type { Wheel } from "./scroll.js";

type Props = {
  width: number;
  height: number;
  focused: boolean;
  problems: Diagnostic[];
  /** Checkers still running, e.g. ["TypeScript"]. */
  checking: string[];
  wheel?: Wheel | null;
  onJump(file: string, line: number): void;
  onClose(): void;
};

type Row = { kind: "file"; file: string; errors: number; warnings: number } | { kind: "problem"; d: Diagnostic };

export const SEVERITY_STYLE = {
  error: { icon: "✖", color: C.red },
  warning: { icon: "▲", color: C.yellow },
  info: { icon: "ℹ", color: C.accent },
} as const;

export function ProblemsView({ width, height, focused, problems, checking, wheel, onJump, onClose }: Props) {
  const [cursor, setCursor] = useState(0);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const { frame } = useAnimation({ interval: 80, isActive: checking.length > 0 });

  const rows = useMemo(() => {
    const list = onlyErrors ? problems.filter((d) => d.severity === "error") : problems;
    const out: Row[] = [];
    let current = "";
    for (const d of list) {
      if (d.file !== current) {
        current = d.file;
        const inFile = list.filter((x) => x.file === d.file);
        out.push({
          kind: "file",
          file: d.file,
          errors: inFile.filter((x) => x.severity === "error").length,
          warnings: inFile.filter((x) => x.severity === "warning").length,
        });
      }
      out.push({ kind: "problem", d });
    }
    return out;
  }, [problems, onlyErrors]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))), [rows.length]);
  useEffect(() => {
    if (wheel?.lines) setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + wheel.lines)));
  }, [wheel?.nonce]);

  const visibleRows = Math.max(1, height - 4);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - visibleRows));
    else if (key.pageDown) setCursor((c) => Math.min(rows.length - 1, c + visibleRows));
    else if (input === "e") setOnlyErrors((v) => !v);
    else if (input === "p" || key.escape) onClose();
    else if (key.return) {
      const row = rows[cursor];
      if (row?.kind === "problem") onJump(row.d.file, row.d.line);
      else if (row?.kind === "file") onJump(row.file, problems.find((d) => d.file === row.file)?.line ?? 1);
    }
  }, { isActive: focused });

  const errors = problems.filter((d) => d.severity === "error").length;
  const warnings = problems.filter((d) => d.severity === "warning").length;
  const start = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), rows.length - visibleRows));
  const title = (
    <>
      {" "}<Text color={C.red}>✖ {errors}</Text>  <Text color={C.yellow}>▲ {warnings}</Text>  Problems
      {checking.length > 0 && <Text color={C.accent2}>  {SPINNER[frame % SPINNER.length]} checking {checking.join(", ")}</Text>}
      <Text color={C.dim}>{onlyErrors ? "  (errors only)" : ""}</Text>
    </>
  );

  return (
    <Pane title={title} width={width} height={height} focused={focused} {...(focused ? { accent: C.red } : {})}>
      <Box flexDirection="column" height={visibleRows}>
        {rows.length === 0 && (
          <Box flexDirection="column" paddingX={1}>
            <Text color={C.green}>{checking.length ? "Checking…" : "✓ No problems found"}</Text>
            <Text color={C.dim}>Checked by the syntax parser, plus ESLint, TypeScript, Ruff and language servers when your project has them.</Text>
          </Box>
        )}
        {rows.slice(start, start + visibleRows).map((row, i) => {
          const selected = focused && start + i === cursor;
          const bg = selected ? { backgroundColor: C.panel } : {};
          if (row.kind === "file") {
            const { icon, color } = fileIcon(row.file);
            return (
              <Text key={`f${row.file}`} wrap="truncate-end" {...bg}>
                <Text color={color}>{icon}</Text> <Text bold color={C.text}>{row.file}</Text>
                {row.errors > 0 && <Text color={C.red}>  ✖ {row.errors}</Text>}
                {row.warnings > 0 && <Text color={C.yellow}>  ▲ {row.warnings}</Text>}
              </Text>
            );
          }
          const style = SEVERITY_STYLE[row.d.severity];
          return (
            <Text key={`${row.d.file}:${row.d.line}:${row.d.col}:${i}`} wrap="truncate-end" {...bg}>
              {"  "}<Text color={style.color}>{style.icon}</Text>
              <Text color={C.dim}> {String(row.d.line).padStart(4)}:{String(row.d.col).padEnd(3)} </Text>
              <Text {...(selected ? { color: C.text } : {})}>{row.d.message}</Text>
              <Text color={C.dim}>  {row.d.source}{row.d.code ? ` ${row.d.code}` : ""}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={C.dim} wrap="truncate-end"> ↑↓ move · Enter go to line · e errors only · p/Esc close</Text>
    </Pane>
  );
}
