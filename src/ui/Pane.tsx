import type { ReactNode } from "react";
import { Box, Text } from "ink";

type Props = {
  title: string;
  width: number;
  height: number;
  focused: boolean;
  accent?: string;
  children: ReactNode;
};

/** A bordered panel with a title row. Content gets `width - 2` columns and `height - 3` rows. */
export function Pane({ title, width, height, focused, accent, children }: Props) {
  const color = accent ?? (focused ? "cyan" : "gray");
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={color} overflow="hidden">
      <Text bold color={color} wrap="truncate-end">{title}</Text>
      {children}
    </Box>
  );
}
