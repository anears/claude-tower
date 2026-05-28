import { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { TranscriptEntry } from '../types/message.js';
import { markdownToLines, type MdLine } from '../lib/markdown.js';
import { formatToolUse, formatToolResult } from '../lib/tool-format.js';

interface Props {
  entries: TranscriptEntry[];
  loading: boolean;
  error?: string;
  width: number;
  height: number;
  focused?: boolean;
  scrollOffset?: number; // lines above the bottom (0 = tailing latest)
  onClamp?: (clamped: number) => void; // called when scrollOffset is out of range
}

function roleColor(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'cyan' : 'white';
}

function buildLines(entries: TranscriptEntry[], innerWidth: number): MdLine[] {
  const out: MdLine[] = [];
  const blank: MdLine = { segments: [{ text: ' ' }] };

  for (const entry of entries) {
    if (entry.type === 'system') continue;
    if (entry.type === 'summary') {
      out.push(...markdownToLines(`[summary] ${entry.summary ?? ''}`, innerWidth, 'magenta'));
      out.push(blank);
      continue;
    }
    const role = entry.type; // 'user' | 'assistant'
    const color = roleColor(role);
    // Role header line — bold uppercase, role color.
    out.push({ segments: [{ text: role.toUpperCase(), color, bold: true }] });

    const content = entry.message.content;
    if (typeof content === 'string') {
      out.push(...markdownToLines(content, innerWidth, color));
    } else {
      for (const block of content) {
        switch (block.type) {
          case 'text':
            out.push(...markdownToLines(block.text, innerWidth, color));
            break;
          case 'tool_use':
            out.push(...formatToolUse(block.name, block.input, innerWidth));
            break;
          case 'tool_result':
            out.push(...formatToolResult(block.content, block.is_error === true, innerWidth));
            break;
          case 'thinking':
            out.push(...markdownToLines(block.thinking, innerWidth, 'magenta'));
            break;
        }
      }
    }
    out.push(blank);
  }
  return out;
}

export function Transcript({
  entries,
  loading,
  error,
  width,
  height,
  focused,
  scrollOffset = 0,
  onClamp,
}: Props) {
  const innerWidth = Math.max(10, width - 4); // borders (2) + paddingX (2)
  const headerLines = 1; // single scroll-position hint line
  const maxLines = Math.max(3, height - 2 - headerLines); // borders (2) + header

  // Building lines is the expensive part for large transcripts — memoize.
  const allLines = useMemo(() => buildLines(entries, innerWidth), [entries, innerWidth]);
  const maxOffset = Math.max(0, allLines.length - maxLines);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = allLines.length - offset;
  const start = Math.max(0, end - maxLines);
  const visible = allLines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = allLines.length - end;

  // Surface the clamped value back to the parent so keys like `g` (set to a
  // sentinel "top") store the real maximum, letting subsequent ↓ presses
  // actually decrement from it.
  useEffect(() => {
    if (onClamp && scrollOffset !== offset) onClamp(offset);
  }, [scrollOffset, offset, onClamp]);

  // Single thin header line — just shows scroll position when scrolled away.
  const scrollHint =
    hiddenAbove > 0 || hiddenBelow > 0
      ? `${hiddenAbove > 0 ? `↑${hiddenAbove}` : ''}${hiddenAbove > 0 && hiddenBelow > 0 ? ' · ' : ''}${hiddenBelow > 0 ? `↓${hiddenBelow} (G로 최신)` : ''}`
      : `${entries.length} entries`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      width={width}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Text dimColor wrap="truncate-end">
        {scrollHint}
      </Text>
      <Box flexDirection="column">
        {loading ? (
          <Text>
            <Spinner type="dots" /> Loading transcript...
          </Text>
        ) : error ? (
          <Text color="red">Error: {error}</Text>
        ) : entries.length === 0 ? (
          <Text dimColor>(empty — select a session)</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line.segments.map((seg, j) => (
                <Text
                  key={j}
                  color={seg.color}
                  bold={seg.bold}
                  italic={seg.italic}
                  dimColor={seg.dim}
                >
                  {seg.text === '' ? ' ' : seg.text}
                </Text>
              ))}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
