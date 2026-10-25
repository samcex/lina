import React, { memo } from 'react';
import { Box, Text } from 'ink';

/** Renders pre-wrapped ANSI lines, one Text per line, clipped to the box. */
export const Lines = memo(function Lines({ lines, height, width }: { lines: string[]; height?: number; width?: number }) {
  const shown = height !== undefined ? lines.slice(0, height) : lines;
  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {shown.map((l, i) => (
        <Text key={i} wrap="truncate-end">{l === '' ? ' ' : l}</Text>
      ))}
    </Box>
  );
});
