import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { SessionInfo } from '../types/message.js';
import { windowStart } from '../lib/scroll.js';
import { getSessionBadge } from '../lib/status.js';
import { timeAgo, shortCwd } from '../lib/time.js';
import { UI } from '../constants.js';

interface Props {
  sessions: SessionInfo[];
  selectedIndex: number;
  focused: boolean;
  loading: boolean;
  error?: string;
  height: number;
}

const LINES_PER_ITEM = 2;

export function SessionList({ sessions, selectedIndex, focused, loading, error, height }: Props) {
  const avail = Math.max(1, height - 3); // content lines inside borders, minus title
  const allFit = sessions.length * LINES_PER_ITEM <= avail;
  // When scrolling, try to reserve 2 lines for the ↑/↓ indicators.
  const itemCap = allFit
    ? sessions.length
    : Math.max(1, Math.floor((avail - 2) / LINES_PER_ITEM));

  const start = windowStart(selectedIndex, sessions.length, itemCap);
  const visible = sessions.slice(start, start + itemCap);
  const moreAbove = start;
  const moreBelow = Math.max(0, sessions.length - (start + itemCap));

  // Only draw indicators if there are spare lines, so we never overflow the box.
  let leftover = avail - visible.length * LINES_PER_ITEM;
  const showAbove = moreAbove > 0 && leftover >= 1;
  if (showAbove) leftover -= 1;
  const showBelow = moreBelow > 0 && leftover >= 1;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      width={UI.sessionListWidth}
      height={height}
      paddingX={1}
    >
      <Text bold color={focused ? 'cyan' : 'white'}>
        Sessions{sessions.length > 0 ? ` (${sessions.length})` : ''}
      </Text>
      <Box flexDirection="column">
        {loading ? (
          <Text>
            <Spinner type="dots" /> Loading...
          </Text>
        ) : error ? (
          <Text color="red" wrap="truncate-end">
            Error: {error}
          </Text>
        ) : sessions.length === 0 ? (
          <Text dimColor>(no sessions)</Text>
        ) : (
          <>
            {showAbove && <Text dimColor>  ↑ {moreAbove} more</Text>}
            {visible.map((s, i) => {
              const realIdx = start + i;
              const selected = realIdx === selectedIndex;
              const badge = getSessionBadge(s, false);
              const live = s.liveOn.length > 0;
              const headline = s.aiTitle ?? shortCwd(s.cwd);
              return (
                <Box key={s.filePath} flexDirection="column">
                  <Text
                    color={selected ? 'green' : undefined}
                    inverse={focused && selected}
                    wrap="truncate-end"
                  >
                    {selected ? '> ' : '  '}
                    <Text color={badge.color}>{badge.dot} </Text>
                    {headline}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'    '}
                    {live ? `${badge.label} ▶${s.liveOn.join(',')} · ` : ''}
                    {shortCwd(s.cwd)} · {timeAgo(s.lastModified)}
                  </Text>
                </Box>
              );
            })}
            {showBelow && <Text dimColor>  ↓ {moreBelow} more</Text>}
          </>
        )}
      </Box>
    </Box>
  );
}
