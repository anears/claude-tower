import { wrapToWidth } from './wrap.js';

// Styled segment of a single line. Rendered as a nested <Text> in Ink so we
// can mix bold / italic / color inside one line (markdown bold, inline code).
export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}

export interface MdLine {
  segments: Segment[];
}

// Matches an inline markdown token. Order matters in the alternation: longer /
// more specific patterns first so `**bold**` isn't mis-parsed as two italics.
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/;

function parseInline(text: string, defaultColor?: string): Segment[] {
  const segs: Segment[] = [];
  let s = text;
  while (s.length > 0) {
    const m = s.match(INLINE);
    if (!m || m.index === undefined) {
      segs.push({ text: s, color: defaultColor });
      break;
    }
    if (m.index > 0) segs.push({ text: s.slice(0, m.index), color: defaultColor });
    const tok = m[0];
    if (tok.startsWith('**')) {
      segs.push({ text: tok.slice(2, -2), color: defaultColor, bold: true });
    } else if (tok.startsWith('`')) {
      segs.push({ text: tok.slice(1, -1), color: 'cyan' });
    } else if (tok.startsWith('[')) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        segs.push({ text: link[1]!, color: 'blue' });
        segs.push({ text: ` (${link[2]!})`, color: defaultColor, dim: true });
      } else {
        segs.push({ text: tok, color: defaultColor });
      }
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      segs.push({ text: tok.slice(1, -1), color: defaultColor, italic: true });
    } else {
      segs.push({ text: tok, color: defaultColor });
    }
    s = s.slice(m.index + tok.length);
  }
  return segs;
}

// Convert a markdown document (often the contents of a chat message) into a
// list of display lines. Each line carries styled segments ready to render.
// Width-aware: wraps long lines using string-width before inline parsing.
export function markdownToLines(
  text: string,
  width: number,
  defaultColor?: string,
): MdLine[] {
  const out: MdLine[] = [];
  const rawLines = text.split('\n');
  let inCode = false;

  for (const raw of rawLines) {
    const trimmed = raw.trimEnd();

    // Code fence
    const fence = trimmed.match(/^\s*```(.*)$/);
    if (fence) {
      inCode = !inCode;
      const lang = (fence[1] ?? '').trim();
      out.push({ segments: [{ text: inCode ? `┌── ${lang || 'code'} ──` : '└──', dim: true }] });
      continue;
    }
    if (inCode) {
      // Preserve code lines literally; wrap on width.
      for (const w of wrapToWidth(raw, width)) {
        out.push({ segments: [{ text: w, color: 'cyan' }] });
      }
      continue;
    }

    // Header — dim the `#` marker, bold+color the body so the hierarchy reads
    // at a glance without the markers shouting.
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const headerColor = level === 1 ? 'magenta' : level === 2 ? 'cyan' : 'green';
      const wrapped = wrapToWidth(h[2]!, Math.max(8, width - level - 1));
      for (let i = 0; i < wrapped.length; i++) {
        const marker = i === 0 ? '#'.repeat(level) + ' ' : ' '.repeat(level + 1);
        out.push({
          segments: [
            { text: marker, dim: true },
            { text: wrapped[i]!, color: headerColor, bold: true },
          ],
        });
      }
      continue;
    }

    // List item
    const list = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (list) {
      const lead = list[1]!;
      const marker = list[2]!;
      const bullet = /^\d+\.$/.test(marker) ? marker + ' ' : '• ';
      const indent = lead + bullet;
      const wrapped = wrapToWidth(list[3]!, Math.max(8, width - indent.length));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? indent : ' '.repeat(indent.length);
        out.push({
          segments: [
            { text: prefix, color: 'yellow' },
            ...parseInline(wrapped[i]!, defaultColor),
          ],
        });
      }
      continue;
    }

    // Block quote
    if (trimmed.startsWith('> ')) {
      const body = trimmed.slice(2);
      const wrapped = wrapToWidth(body, Math.max(8, width - 2));
      for (const w of wrapped) {
        out.push({
          segments: [{ text: '│ ', color: 'gray' }, ...parseInline(w, defaultColor)],
        });
      }
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) {
      out.push({ segments: [{ text: '─'.repeat(Math.max(3, width)), dim: true }] });
      continue;
    }

    // Empty line → render as blank
    if (raw.trim() === '') {
      out.push({ segments: [{ text: ' ' }] });
      continue;
    }

    // Regular paragraph: width-wrap, then inline-parse per wrapped line.
    for (const w of wrapToWidth(raw, width)) {
      out.push({ segments: parseInline(w, defaultColor) });
    }
  }

  return out;
}
