import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  width: number;
  textLines: number; // how many lines the input area should occupy
  focused: boolean; // input mode active
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  target?: string; // host-qualified tmux target, if sendable
  disabledReason?: string; // why sending is unavailable
  status?: string; // busy / idle / running
}

export function Composer({
  width,
  textLines,
  focused,
  value,
  onChange,
  onSubmit,
  target,
  disabledReason,
  status,
}: Props) {
  const sendable = !!target;
  const borderColor = focused ? 'cyan' : 'gray';
  const lines = Math.max(1, textLines);
  const gutterColor = status === 'busy' ? 'yellow' : focused ? 'cyan' : 'gray';

  return (
    <Box
      width={width}
      height={lines + 2}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      overflow="hidden"
    >
      {!sendable ? (
        <Text dimColor wrap="truncate-end">
          ✎ {disabledReason ?? '입력 불가'}
        </Text>
      ) : (
        <Box width={width - 4} height={lines} overflow="hidden">
          <Box width={2} flexShrink={0}>
            <Text color={gutterColor}>▸ </Text>
          </Box>
          <Box width={width - 6} height={lines} overflow="hidden">
            {focused ? (
              <TextInput
                value={value}
                onChange={onChange}
                onSubmit={onSubmit}
                focus={focused}
                placeholder="메시지 입력 후 Enter · Esc로 나가기"
              />
            ) : (
              <Text dimColor wrap="truncate-end">
                메시지를 보내려면 [i] 또는 [Enter]
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
