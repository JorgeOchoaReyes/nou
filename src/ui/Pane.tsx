import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { C } from "./theme.js";

type Props = {
  title: ReactNode;
  width: number;
  height: number;
  focused: boolean;
  accent?: string;
  children: ReactNode;
};

/** A bordered panel with a title row. Content gets `width - 2` columns and `height - 3` rows. */
export function Pane({ title, width, height, focused, accent, children }: Props) {
  const color = accent ?? (focused ? C.accent : C.border);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={focused || accent ? "round" : "single"}
      borderColor={color}
      overflow="hidden"
    >
      {/* Titles are read, so an unfocused one is in the text color; only its border is quiet. */}
      <Text bold color={focused || accent ? color : C.text} wrap="truncate-end">{title}</Text>
      {children}
    </Box>
  );
}
