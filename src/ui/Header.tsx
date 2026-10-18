import { memo } from "react";
import path from "path";
import { Box, Text, useAnimation } from "ink";
import { C, SPINNER, gradient } from "./theme.js";
import { currentVersion } from "../update/index.js";

const VERSION = `v${currentVersion()}`;

type Props = {
  width: number;
  branch: string | null;
  changes: number;
  model: string;
  local: boolean;
  busy: string | null;
  /** Newer version on npm, if any. */
  update: string | null;
};

export const Header = memo(function Header({ width, branch, changes, model, local, busy, update }: Props) {
  const { frame } = useAnimation({ interval: 120, isActive: !!busy });
  const project = path.basename(process.cwd());
  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate-end">
        {" "}
        {gradient("◆ NOU", busy ? frame : 0).map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
        <Text color={C.dim}> {VERSION}</Text>
        <Text color={C.dim}>  │  </Text>
        <Text color={C.text}>{project}</Text>
        {branch && (
          <>
            <Text color={C.dim}>  │  </Text>
            <Text color={C.accent2}>⎇ {branch}</Text>
            {changes > 0 && <Text color={C.yellow}> ±{changes}</Text>}
          </>
        )}
        {busy && <Text color={C.accent2}>{"  "}{SPINNER[frame % SPINNER.length]} {busy}</Text>}
      </Text>
      <Text>
        {update && <Text color={C.green} bold>⬆ v{update} available · run `nou update`  </Text>}
        <Text backgroundColor={local ? C.green : C.accent2} color="black" bold>{` ${local ? "⌂ LOCAL" : "☁ CLOUD"} `}</Text>
        <Text backgroundColor={C.panel} color={C.text}>{` ${model} `}</Text>
        {" "}
      </Text>
    </Box>
  );
});
