import { TranscriptEntry } from '../types/message.js';

export function parseJsonl(content: string): TranscriptEntry[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const result = TranscriptEntry.safeParse(obj);
      if (result.success) entries.push(result.data);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export function decodeProjectDir(encoded: string): string {
  // Claude Code encodes cwd by replacing '/' with '-'
  // The reverse is heuristic — we just return the encoded form prefixed with '/'
  return encoded.startsWith('-') ? encoded.replace(/-/g, '/') : encoded;
}
