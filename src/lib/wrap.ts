import stringWidth from 'string-width';

// Display width in terminal columns. Uses string-width's default (ambiguous =
// narrow), matching Ink's own measurement and terminals configured for legacy
// (wcswidth) grapheme widths.
const sw = (s: string): number => stringWidth(s);

// Grapheme segmentation so emoji (ZWJ sequences, surrogate pairs, skin-tone
// modifiers) and combining marks are never split mid-character.
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s); // fallback: code points (still surrogate-safe)
}

// Wrap text to a fixed number of *display columns* (not code units). Greedy
// word-wrap; tokens wider than the column budget are hard-broken on grapheme
// boundaries. CJK and emoji count as their true terminal width.
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];

  for (const rawLine of text.replace(/\t/g, '  ').split('\n')) {
    if (sw(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    let current = '';
    let curW = 0;
    const flush = () => {
      out.push(current);
      current = '';
      curW = 0;
    };

    for (const word of rawLine.split(/(\s+)/)) {
      if (word === '') continue;
      const wordW = sw(word);

      if (wordW > width) {
        // Token longer than a full line — hard-break by graphemes.
        if (current) flush();
        for (const g of graphemes(word)) {
          const gW = sw(g);
          if (curW + gW > width) flush();
          current += g;
          curW += gW;
        }
      } else if (curW + wordW > width) {
        flush();
        const trimmed = word.replace(/^\s+/, '');
        current = trimmed;
        curW = sw(trimmed);
      } else {
        current += word;
        curW += wordW;
      }
    }
    out.push(current);
  }
  return out;
}

// Number of display lines `text` occupies at the given column width (>= 1).
export function countLines(text: string, width: number): number {
  if (!text) return 1;
  return Math.max(1, wrapToWidth(text, width).length);
}
