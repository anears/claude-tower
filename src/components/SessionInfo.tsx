import { Box, Text } from 'ink';
import type { SessionInfo as Session } from '../types/message.js';
import { bar, fmtCost, fmtTokens, shortModel, pctColor, type SessionUsage } from '../lib/usage.js';
import { getSessionBadge } from '../lib/status.js';

interface Props {
  width: number;
  height: number;
  session?: Session;
  usage?: SessionUsage;
  turns: number;
  entries: number;
}

export function SessionInfoPanel({ width, height, session, usage, turns, entries }: Props) {
  if (!session) {
    return (
      <Box
        width={width}
        height={height}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Text dimColor>세션을 선택하세요</Text>
      </Box>
    );
  }

  const badge = getSessionBadge(session);
  const title = session.aiTitle ?? session.cwd;
  const model = usage?.model ? shortModel(usage.model) : '?';

  const ctx = (() => {
    const u = usage;
    if (!u || u.contextTokens <= 0 || u.contextMax <= 0) return null;
    const r = u.contextTokens / u.contextMax;
    return {
      ratio: r,
      barStr: bar(r, 6),
      label: `${fmtTokens(u.contextTokens)}/${fmtTokens(u.contextMax)} (${Math.round(r * 100)}%)`,
      color: pctColor(r * 100),
    };
  })();
  const cost = usage && usage.totalCost > 0 ? `~${fmtCost(usage.totalCost)}` : null;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold wrap="truncate-end">
        {title}
      </Text>
      <Text dimColor wrap="truncate-middle">
        {session.cwd}
      </Text>
      <Text wrap="truncate-end">
        <Text color={badge.color}>{badge.dot} </Text>
        <Text>{badge.label}</Text>
        {session.liveOn.length > 0 ? (
          <Text dimColor>
            {' '}on {session.liveOn.join(',')}
            {session.tmuxTarget ? ` (${session.tmuxTarget.split(':').slice(1).join(':')})` : ''}
          </Text>
        ) : null}
        <Text dimColor> · </Text>
        <Text>{model}</Text>
        {session.gitBranch ? (
          <>
            <Text dimColor> · </Text>
            <Text>{session.gitBranch}</Text>
          </>
        ) : null}
      </Text>
      <Text wrap="truncate-end">
        {ctx ? (
          <>
            <Text dimColor>ctx </Text>
            <Text color={ctx.color}>{ctx.barStr}</Text>
            <Text dimColor> {ctx.label} · </Text>
          </>
        ) : null}
        {cost ? (
          <>
            <Text>{cost}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        <Text dimColor>
          {turns} turns · {entries} entries
        </Text>
      </Text>
    </Box>
  );
}
