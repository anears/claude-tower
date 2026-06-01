import type { TranscriptEntry } from '../types/message.js';

// Count user "turns" (messages with actual text, not just tool_result blocks)
// and total assistant output tokens across a transcript. Extracted from the
// identical loop that lived in both App.tsx and smoke-test.ts.
export function computeTranscriptStats(entries: TranscriptEntry[]): {
  turns: number;
  outTokens: number;
} {
  let turns = 0;
  let outTokens = 0;
  for (const e of entries) {
    if (e.type === 'user') {
      const c = e.message.content;
      const hasText = typeof c === 'string' ? c.trim().length > 0 : c.some((b) => b.type === 'text');
      if (hasText) turns++;
    } else if (e.type === 'assistant') {
      outTokens += e.message.usage?.output_tokens ?? 0;
    }
  }
  return { turns, outTokens };
}
