import { Box, Text } from 'ink';
import type { RateLimits, RateWindow } from '../lib/usage.js';
import { bar, untilReset } from '../lib/usage.js';

interface Props {
  limits?: RateLimits;
}

function pctColor(p: number): string {
  if (p >= 90) return 'red';
  if (p >= 70) return 'yellow';
  return 'green';
}

function Segment({ label, win }: { label: string; win?: RateWindow }) {
  if (!win) {
    return (
      <Text dimColor>
        {label} —
      </Text>
    );
  }
  const reset = untilReset(win.resetsAt);
  return (
    <Text>
      <Text dimColor>{label} </Text>
      <Text color={pctColor(win.utilization)}>{bar(win.utilization / 100, 8)}</Text>
      <Text dimColor> {win.utilization}%</Text>
      {reset ? <Text dimColor> ({reset})</Text> : null}
    </Text>
  );
}

export function UsageBar({ limits }: Props) {
  if (!limits) {
    return (
      <Box paddingX={1}>
        <Text dimColor>usage —</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Segment label="5h" win={limits.fiveHour} />
        <Text dimColor>  ·  </Text>
        <Segment label="7d" win={limits.sevenDay} />
        <Text dimColor>  ·  </Text>
        <Segment label="7d-sonnet" win={limits.sevenDaySonnet} />
      </Text>
    </Box>
  );
}
