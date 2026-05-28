import { Box, Text } from 'ink';
import { windowStart } from '../lib/scroll.js';

export interface FilterItem {
  label: string;
  hint?: string;
  checked?: boolean; // when defined, renders as a [x] / [ ] toggle
}

interface Props {
  items: FilterItem[];
  selectedIndex: number;
  focused: boolean;
  height: number;
}

export function ServerList({ items, selectedIndex, focused, height }: Props) {
  const avail = Math.max(1, height - 3); // content lines inside borders, minus title
  const allFit = items.length <= avail;
  const itemCap = allFit ? items.length : Math.max(1, avail - 2);
  const start = windowStart(selectedIndex, items.length, itemCap);
  const visible = items.slice(start, start + itemCap);
  const moreBelow = Math.max(0, items.length - (start + itemCap));

  let leftover = avail - visible.length;
  const showAbove = start > 0 && leftover >= 1;
  if (showAbove) leftover -= 1;
  const showBelow = moreBelow > 0 && leftover >= 1;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      width={20}
      height={height}
      paddingX={1}
    >
      <Text bold color={focused ? 'cyan' : 'white'}>
        Filter
      </Text>
      <Box flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>(none)</Text>
        ) : (
          <>
            {showAbove && <Text dimColor>↑ {start} more</Text>}
            {visible.map((item, i) => {
              const realIdx = start + i;
              const selected = realIdx === selectedIndex;
              const checkbox = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
              return (
                <Text
                  key={item.label}
                  color={selected ? 'green' : undefined}
                  inverse={focused && selected}
                  wrap="truncate-end"
                >
                  {selected ? '> ' : '  '}
                  {checkbox}
                  {item.label}
                  {item.hint ? <Text dimColor> {item.hint}</Text> : null}
                </Text>
              );
            })}
            {showBelow && <Text dimColor>↓ {moreBelow} more</Text>}
          </>
        )}
      </Box>
    </Box>
  );
}
