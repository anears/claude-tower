import { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { markdownToLines, type MdLine } from '../lib/markdown.js';
import { renderReportMarkdown, type DailyReport } from '../lib/daily-report.js';

interface Props {
  report?: DailyReport;
  loading: boolean;
  error?: string;
  dateLabel: string; // the day being viewed (shown even before the report builds)
  width: number;
  height: number;
  scrollOffset: number; // lines above the bottom (0 = at the end)
  onClamp?: (clamped: number) => void;
}

const BORDER_PAD = 4; // borders (2) + paddingX (2)

// Full-width overlay that renders the daily work report as scrollable markdown.
// Mirrors Transcript's line-windowing so scrolling feels identical.
export function DailyReport({
  report,
  loading,
  error,
  dateLabel,
  width,
  height,
  scrollOffset,
  onClamp,
}: Props) {
  const innerWidth = Math.max(10, width - BORDER_PAD);
  const headerLines = 1;
  const maxLines = Math.max(3, height - 2 - headerLines);

  const allLines = useMemo<MdLine[]>(
    () => (report ? markdownToLines(renderReportMarkdown(report), innerWidth) : []),
    [report, innerWidth],
  );

  const maxOffset = Math.max(0, allLines.length - maxLines);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = allLines.length - offset;
  const start = Math.max(0, end - maxLines);
  const visible = allLines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = allLines.length - end;

  useEffect(() => {
    if (onClamp && scrollOffset !== offset) onClamp(offset);
  }, [scrollOffset, offset, onClamp]);

  const scrollHint =
    hiddenAbove > 0 || hiddenBelow > 0
      ? `${hiddenAbove > 0 ? `↑${hiddenAbove}` : ''}${hiddenAbove > 0 && hiddenBelow > 0 ? ' · ' : ''}${hiddenBelow > 0 ? `↓${hiddenBelow}` : ''}`
      : '리포트';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      width={width}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Text dimColor wrap="truncate-end">
        📋 {dateLabel} · {scrollHint}
      </Text>
      <Box flexDirection="column">
        {loading ? (
          <Text>
            <Spinner type="dots" /> {dateLabel} 리포트 생성 중…
          </Text>
        ) : error ? (
          <Text color="red">Error: {error}</Text>
        ) : !report ? (
          <Text dimColor>(리포트 없음)</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line.segments.map((seg, j) => (
                <Text key={j} color={seg.color} bold={seg.bold} italic={seg.italic} dimColor={seg.dim}>
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
