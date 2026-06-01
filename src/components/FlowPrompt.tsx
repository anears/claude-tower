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
    <Box>
      <Text color="cyan">{header}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus
        placeholder={placeholder}
      />
    </Box>
  );
}
