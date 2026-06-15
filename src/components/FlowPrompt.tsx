import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { ActiveFlow } from '../hooks/useFlow.js';

interface Props {
  active: ActiveFlow | null;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}

// Renders the active flow's prompt: a yes/no confirm line, or the current
// step's "<header> (n/total) <label>: " followed by a focused text input.
// Returns null when no flow is active (the footer shows help text instead).
export function FlowPrompt({ active, onChange, onSubmit }: Props) {
  if (!active) return null;
  const { def, step, draft, value } = active;

  if (def.confirm) {
    const c = def.confirm;
    return (
      <Text>
        <Text color={c.color}>{c.prefix}</Text>
        <Text bold>{c.subject}</Text>
        <Text color={c.color}>{c.suffix}</Text>
      </Text>
    );
  }

  const stepDef = def.steps[step]!;
  const label = stepDef.label(draft);
  const placeholder = stepDef.placeholder ? stepDef.placeholder(draft) : '';
  const header = `${def.header} (${step + 1}/${def.steps.length}) ${label}: `;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{header}</Text>
        <TextInput
          // Remount when Tab fills the value so the cursor jumps to the end
          // (ink-text-input keeps its own cursor offset across value changes).
          key={`${step}-${active.completeNonce}`}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          placeholder={placeholder}
        />
      </Box>
      {stepDef.complete ? <CompletionList active={active} /> : null}
    </Box>
  );
}

// Folder names from the candidate full paths (everything after the last slash).
function basename(p: string): string {
  const trimmed = p.replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  return `${i >= 0 ? trimmed.slice(i + 1) : trimmed}/`;
}

// The Tab-completion result shown under the input: a spinner-free status while
// listing, then a single truncated line of matching folder names.
function CompletionList({ active }: { active: ActiveFlow }) {
  const { completing, candidates } = active;
  if (completing) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>… 폴더 조회 중</Text>
      </Box>
    );
  }
  if (!candidates) return null; // not tabbed yet
  if (candidates.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>(하위 폴더 없음)</Text>
      </Box>
    );
  }
  const MAX = 30;
  const shown = candidates.slice(0, MAX).map(basename).join('  ');
  const more = candidates.length > MAX ? ` …(+${candidates.length - MAX})` : '';
  return (
    <Box marginLeft={2}>
      <Text dimColor wrap="truncate-end">
        <Text color="green">{candidates.length}개</Text> {shown}
        {more}
      </Text>
    </Box>
  );
}
