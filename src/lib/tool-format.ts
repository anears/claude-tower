import type { MdLine, Segment } from './markdown.js';
import { wrapToWidth } from './wrap.js';

// Per-tool friendly display. Replaces the raw JSON dump with a structured
// summary (file path + diff for Edit, command line for Bash, etc.) and renders
// tool_result content with truncation + error highlighting.

type Input = Record<string, unknown>;

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function tag(name: string): Segment {
  return { text: `[${name}] `, color: 'yellow', bold: true };
}

function shortPath(p: string, max = 60): string {
  if (p.length <= max) return p;
  const head = p.slice(0, 14);
  const tail = p.slice(-(max - 15));
  return `${head}…${tail}`;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

export function formatToolUse(name: string, input: unknown, width: number): MdLine[] {
  const inp = (input ?? {}) as Input;
  const lines: MdLine[] = [];

  switch (name) {
    case 'Edit': {
      const fp = asString(inp.file_path);
      const oldLine = truncate(firstLine(asString(inp.old_string)), Math.max(20, width - 4));
      const newLine = truncate(firstLine(asString(inp.new_string)), Math.max(20, width - 4));
      lines.push({ segments: [tag('Edit'), { text: shortPath(fp), color: 'cyan' }] });
      if (oldLine) lines.push({ segments: [{ text: '  - ', color: 'red' }, { text: oldLine, color: 'red' }] });
      if (newLine) lines.push({ segments: [{ text: '  + ', color: 'green' }, { text: newLine, color: 'green' }] });
      break;
    }
    case 'MultiEdit': {
      const fp = asString(inp.file_path);
      const edits = (inp.edits as unknown[]) ?? [];
      lines.push({
        segments: [tag('MultiEdit'), { text: shortPath(fp), color: 'cyan' }, { text: `  (${edits.length} edits)`, dim: true }],
      });
      break;
    }
    case 'Write': {
      const fp = asString(inp.file_path);
      const content = asString(inp.content);
      const lineCount = content ? content.split('\n').length : 0;
      lines.push({
        segments: [tag('Write'), { text: shortPath(fp), color: 'cyan' }, { text: `  (${lineCount} lines)`, dim: true }],
      });
      break;
    }
    case 'Read': {
      const fp = asString(inp.file_path);
      const offset = inp.offset != null ? Number(inp.offset) : null;
      const limit = inp.limit != null ? Number(inp.limit) : null;
      const range = offset != null || limit != null ? ` [${offset ?? 0}+${limit ?? '…'}]` : '';
      lines.push({ segments: [tag('Read'), { text: shortPath(fp) + range, color: 'cyan' }] });
      break;
    }
    case 'Bash': {
      const cmd = asString(inp.command);
      lines.push({
        segments: [
          tag('Bash'),
          { text: '$ ', color: 'green' },
          { text: truncate(firstLine(cmd), Math.max(20, width - 12)) },
        ],
      });
      const desc = asString(inp.description);
      if (desc) lines.push({ segments: [{ text: '    ' + truncate(desc, width - 6), dim: true }] });
      break;
    }
    case 'Grep': {
      const pat = asString(inp.pattern);
      const path = asString(inp.path);
      const glob = asString(inp.glob);
      const segs: Segment[] = [tag('Grep'), { text: `"${truncate(pat, 80)}"`, color: 'magenta' }];
      if (path) segs.push({ text: ` in ${shortPath(path)}`, color: 'cyan' });
      if (glob) segs.push({ text: ` ${glob}`, dim: true });
      lines.push({ segments: segs });
      break;
    }
    case 'Glob': {
      const pat = asString(inp.pattern);
      const path = asString(inp.path);
      const segs: Segment[] = [tag('Glob'), { text: pat, color: 'magenta' }];
      if (path) segs.push({ text: ` in ${shortPath(path)}`, color: 'cyan' });
      lines.push({ segments: segs });
      break;
    }
    case 'Task': {
      const subType = asString(inp.subagent_type);
      const desc = asString(inp.description);
      lines.push({
        segments: [
          tag('Task'),
          { text: subType, color: 'magenta' },
          desc ? { text: `: ${truncate(desc, width - 16)}` } : { text: '' },
        ],
      });
      break;
    }
    case 'WebFetch': {
      const url = asString(inp.url);
      lines.push({ segments: [tag('WebFetch'), { text: truncate(url, width - 12), color: 'cyan' }] });
      break;
    }
    case 'WebSearch': {
      const query = asString(inp.query);
      lines.push({ segments: [tag('WebSearch'), { text: `"${truncate(query, width - 14)}"`, color: 'magenta' }] });
      break;
    }
    case 'TodoWrite': {
      const todos = (inp.todos as unknown[]) ?? [];
      lines.push({ segments: [tag('TodoWrite'), { text: `${todos.length} items`, dim: true }] });
      break;
    }
    case 'TaskCreate': {
      const subject = asString(inp.subject);
      lines.push({ segments: [tag('TaskCreate'), { text: truncate(subject, width - 14) }] });
      break;
    }
    default: {
      const json = truncate(
        Object.keys(inp).length === 0 ? '' : JSON.stringify(inp),
        Math.max(20, width - name.length - 4),
      );
      lines.push({ segments: [tag(name), { text: json, dim: true }] });
    }
  }
  return lines;
}

export function formatToolResult(content: unknown, isError: boolean, width: number): MdLine[] {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((x) => (typeof x === 'object' && x && 'text' in x ? ((x as { text: string }).text ?? '') : ''))
      .join('');
  } else {
    text = JSON.stringify(content ?? '');
  }

  const MAX_LINES = 8;
  const MAX_CHARS = 2000;
  const truncatedText = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const rawLines = truncatedText.split('\n');
  const visibleRaw = rawLines.slice(0, MAX_LINES);
  const more =
    text.length > MAX_CHARS || rawLines.length > MAX_LINES
      ? `  … (+${Math.max(0, rawLines.length - MAX_LINES)} lines, ${text.length} chars total)`
      : null;

  const color = isError ? 'red' : 'gray';
  const headTag: Segment = isError
    ? { text: 'ERROR ', color: 'red', bold: true }
    : { text: '└─ ', color: 'gray' };

  const out: MdLine[] = [];
  const inner = Math.max(8, width - 4);
  for (let i = 0; i < visibleRaw.length; i++) {
    const raw = visibleRaw[i]!;
    // Wrap each result line within the available width.
    const wrapped = wrapToWidth(raw, inner);
    for (let j = 0; j < wrapped.length; j++) {
      if (i === 0 && j === 0) {
        out.push({ segments: [headTag, { text: wrapped[j]!, color }] });
      } else {
        out.push({ segments: [{ text: '   ' + wrapped[j]!, color }] });
      }
    }
  }
  if (more) out.push({ segments: [{ text: more, dim: true }] });
  if (out.length === 0) {
    out.push({ segments: [headTag, { text: '(empty)', dim: true }] });
  }
  return out;
}
