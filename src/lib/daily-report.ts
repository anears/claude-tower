import type { SessionInfo, TranscriptEntry } from '../types/message.js';
import { computeSessionUsage, fmtCost, shortModel } from './usage.js';

// Builds a "daily work report" by replaying transcript entries that fall inside
// a local calendar day, extracting what the human asked for and what the agent
// did (files touched, commands run), then grouping by project. Pure functions —
// no IO — so they are trivially testable and reusable for both the TUI view and
// the markdown file export. The cost figure reuses computeSessionUsage so the
// pricing table stays in one place (usage.ts).

export interface FileEdit {
  path: string;
  edits: number; // Edit / MultiEdit count
  writes: number; // Write (full overwrite) count
}

export interface SessionActivity {
  sessionId: string;
  title?: string;
  cwd: string;
  source: string; // server name hosting the JSONL
  branch?: string;
  models: string[];
  start: Date; // first in-window entry
  end: Date; // last in-window entry
  turns: number; // human prompts in window
  prompts: string[]; // the human requests (noise-filtered, one line each)
  files: FileEdit[];
  commands: string[]; // first line of each Bash command
  cost: number; // USD estimate for in-window turns
  outTokens: number;
}

export interface ProjectGroup {
  project: string; // display name (basename of cwd)
  cwd: string;
  branches: string[];
  sessions: SessionActivity[];
  start: Date;
  end: Date;
  turns: number;
  prompts: string[];
  files: FileEdit[];
  commands: string[];
  cost: number;
  models: string[];
}

export interface DailyReport {
  dateLabel: string; // YYYY-MM-DD (local)
  generatedAt: Date;
  projects: ProjectGroup[];
  totals: {
    sessions: number;
    projects: number;
    servers: number;
    turns: number;
    cost: number;
    files: number;
    commands: number;
  };
}

// ---- Date helpers -----------------------------------------------------------

export interface DayWindow {
  start: Date;
  end: Date;
  label: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function localDateLabel(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Local-midnight bounds for the calendar day containing `d` (inclusive start,
// exclusive end). Entries are compared in absolute time, so a UTC timestamp is
// bucketed into the viewer's local day — what "today's work" intuitively means.
export function dayWindow(d: Date): DayWindow {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return { start, end, label: localDateLabel(start) };
}

// Parse a 'YYYY-MM-DD' label into a local Date (noon, to dodge DST edges).
// Returns null for anything that isn't a well-formed date label.
export function parseDateLabel(label: string): Date | null {
  const m = label.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return new Date(y, mo - 1, da, 12, 0, 0, 0);
}

// ---- Extraction -------------------------------------------------------------

function entryTime(e: TranscriptEntry): Date | null {
  const ts = 'timestamp' in e ? e.timestamp : undefined;
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstLine(s: string): string {
  const collapsed = s.replace(/\r/g, '').trim();
  const nl = collapsed.indexOf('\n');
  const line = nl < 0 ? collapsed : collapsed.slice(0, nl);
  return line.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// User-turn text that Claude Code injects rather than the human typing it:
// slash-command expansions, bash blocks, local command stdout, interrupt
// markers, and pure system-reminder wrappers. Dropping these keeps the report's
// "요청" list to actual human requests.
const NOISE_PREFIXES = [
  '<command-', // <command-name>, <command-message>, <command-args>, <command-contents>
  '<local-command-', // <local-command-stdout>, <local-command-stderr>, <local-command-caveat>
  '<bash-', // <bash-input>, <bash-stdout>, <bash-stderr>
  '<user-prompt-submit-hook>',
  'Caveat:',
  '[Request interrupted',
  'API Error',
];

function isNoisePrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  for (const p of NOISE_PREFIXES) if (t.startsWith(p)) return true;
  // A turn whose entire body is a system-reminder block (no real user text).
  if (t.startsWith('<system-reminder>') && t.endsWith('</system-reminder>')) return true;
  return false;
}

function addFile(map: Map<string, FileEdit>, path: string, kind: 'edit' | 'write', count = 1): void {
  if (!path) return;
  const cur = map.get(path) ?? { path, edits: 0, writes: 0 };
  if (kind === 'edit') cur.edits += count;
  else cur.writes += count;
  map.set(path, cur);
}

function collectTool(
  name: string,
  input: unknown,
  files: Map<string, FileEdit>,
  commands: string[],
): void {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Edit':
      addFile(files, str(inp.file_path), 'edit');
      break;
    case 'MultiEdit':
      addFile(files, str(inp.file_path), 'edit', Array.isArray(inp.edits) ? inp.edits.length : 1);
      break;
    case 'Write':
      addFile(files, str(inp.file_path), 'write');
      break;
    case 'NotebookEdit':
      addFile(files, str(inp.notebook_path), 'edit');
      break;
    case 'Bash': {
      const cmd = firstLine(str(inp.command));
      if (cmd) commands.push(cmd);
      break;
    }
  }
}

// Replay one session's transcript inside [window.start, window.end) and return
// what happened, or null if the session had no activity in the window.
export function extractSessionActivity(
  session: Pick<SessionInfo, 'sessionId' | 'aiTitle' | 'cwd' | 'source' | 'gitBranch'>,
  entries: TranscriptEntry[],
  window: DayWindow,
): SessionActivity | null {
  const prompts: string[] = [];
  const files = new Map<string, FileEdit>();
  const commands: string[] = [];
  const models = new Set<string>();
  const windowEntries: TranscriptEntry[] = [];
  let turns = 0;
  let start: Date | undefined;
  let end: Date | undefined;

  for (const e of entries) {
    const ts = entryTime(e);
    if (!ts || ts < window.start || ts >= window.end) continue;
    windowEntries.push(e);
    if (!start || ts < start) start = ts;
    if (!end || ts > end) end = ts;

    if (e.type === 'user') {
      const c = e.message.content;
      const text =
        typeof c === 'string'
          ? c
          : c
              .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      if (text.trim() && !isNoisePrompt(text)) {
        turns++;
        prompts.push(truncate(firstLine(text), 160));
      }
    } else if (e.type === 'assistant') {
      const m = e.message.model;
      if (m && m !== '<synthetic>') models.add(m);
      for (const b of e.message.content) {
        if (b.type === 'tool_use') collectTool(b.name, b.input, files, commands);
      }
    }
  }

  if (windowEntries.length === 0 || !start || !end) return null;

  const usage = computeSessionUsage(windowEntries);
  return {
    sessionId: session.sessionId,
    title: session.aiTitle,
    cwd: session.cwd,
    source: session.source,
    branch: session.gitBranch,
    models: [...models],
    start,
    end,
    turns,
    prompts,
    files: [...files.values()],
    commands: dedupeKeepOrder(commands),
    cost: usage.totalCost,
    outTokens: windowEntries.reduce(
      (n, e) => n + (e.type === 'assistant' ? (e.message.usage?.output_tokens ?? 0) : 0),
      0,
    ),
  };
}

function dedupeKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function mergeFiles(groups: FileEdit[][]): FileEdit[] {
  const map = new Map<string, FileEdit>();
  for (const list of groups) {
    for (const f of list) {
      const cur = map.get(f.path) ?? { path: f.path, edits: 0, writes: 0 };
      cur.edits += f.edits;
      cur.writes += f.writes;
      map.set(f.path, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.edits + b.writes - (a.edits + a.writes));
}

// Group the day's session activities by working directory into a report.
export function buildDailyReport(dateLabel: string, activities: SessionActivity[], generatedAt: Date): DailyReport {
  const byCwd = new Map<string, SessionActivity[]>();
  for (const a of activities) {
    const list = byCwd.get(a.cwd) ?? [];
    list.push(a);
    byCwd.set(a.cwd, list);
  }

  const projects: ProjectGroup[] = [];
  for (const [cwd, sessions] of byCwd) {
    sessions.sort((a, b) => a.start.getTime() - b.start.getTime());
    const branches = dedupeKeepOrder(sessions.map((s) => s.branch).filter((b): b is string => !!b));
    const models = dedupeKeepOrder(sessions.flatMap((s) => s.models));
    projects.push({
      project: basename(cwd),
      cwd,
      branches,
      sessions,
      start: new Date(Math.min(...sessions.map((s) => s.start.getTime()))),
      end: new Date(Math.max(...sessions.map((s) => s.end.getTime()))),
      turns: sessions.reduce((n, s) => n + s.turns, 0),
      prompts: sessions.flatMap((s) => s.prompts),
      files: mergeFiles(sessions.map((s) => s.files)),
      commands: dedupeKeepOrder(sessions.flatMap((s) => s.commands)),
      cost: sessions.reduce((n, s) => n + s.cost, 0),
      models,
    });
  }

  // Busiest projects first (by turns, then cost).
  projects.sort((a, b) => b.turns - a.turns || b.cost - a.cost);

  const servers = new Set(activities.map((a) => a.source));
  return {
    dateLabel,
    generatedAt,
    projects,
    totals: {
      sessions: activities.length,
      projects: projects.length,
      servers: servers.size,
      turns: projects.reduce((n, p) => n + p.turns, 0),
      cost: projects.reduce((n, p) => n + p.cost, 0),
      files: projects.reduce((n, p) => n + p.files.length, 0),
      commands: projects.reduce((n, p) => n + p.commands.length, 0),
    },
  };
}

// ---- Markdown rendering -----------------------------------------------------

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed || p : trimmed.slice(i + 1);
}

function tilde(p: string): string {
  return p.replace(/^\/(?:home|Users)\/[^/]+/, '~');
}

function relPath(path: string, cwd: string): string {
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1);
  return tilde(path);
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function timeSpan(start: Date, end: Date): string {
  const a = hhmm(start);
  const b = hhmm(end);
  return a === b ? a : `${a}–${b}`;
}

const MAX_FILES = 40;
const MAX_COMMANDS = 30;
const MAX_PROMPTS = 30;

// Render the report as a Markdown document — the same text used for both the
// in-TUI viewer (via markdownToLines) and the saved .md file.
export function renderReportMarkdown(report: DailyReport): string {
  const out: string[] = [];
  const t = report.totals;

  out.push(`# 일일 업무 보고 — ${report.dateLabel}`);
  out.push('');
  out.push(
    `> ${localDateLabel(report.generatedAt)} ${hhmm(report.generatedAt)} 생성 · ` +
      `세션 ${t.sessions} · 프로젝트 ${t.projects} · 서버 ${t.servers} · ` +
      `요청 ${t.turns}건 · 파일 ${t.files} · 명령 ${t.commands} · 추정 비용 ${fmtCost(t.cost)}`,
  );
  out.push('');

  if (report.projects.length === 0) {
    out.push('_이 날짜에는 기록된 활동이 없습니다._');
    out.push('');
    return out.join('\n');
  }

  for (const p of report.projects) {
    const branchTag = p.branches.length ? `  (${p.branches.join(', ')})` : '';
    out.push(`## ${p.project}  \`${tilde(p.cwd)}\`${branchTag}`);
    out.push('');
    const modelTag = p.models.length ? ` · ${p.models.map(shortModel).join(', ')}` : '';
    out.push(
      `**세션 ${p.sessions.length}개 · ${timeSpan(p.start, p.end)} · ` +
        `요청 ${p.turns}건 · ${fmtCost(p.cost)}${modelTag}**`,
    );
    out.push('');

    const prompts = dedupeKeepOrder(p.prompts);
    if (prompts.length) {
      out.push('### 요청');
      for (const q of prompts.slice(0, MAX_PROMPTS)) out.push(`- ${q}`);
      if (prompts.length > MAX_PROMPTS) out.push(`- _…외 ${prompts.length - MAX_PROMPTS}건_`);
      out.push('');
    }

    if (p.files.length) {
      out.push(`### 변경한 파일 (${p.files.length})`);
      for (const f of p.files.slice(0, MAX_FILES)) {
        const parts: string[] = [];
        if (f.writes) parts.push(`${f.writes} write`);
        if (f.edits) parts.push(`${f.edits} edit`);
        out.push(`- \`${relPath(f.path, p.cwd)}\` (${parts.join(', ')})`);
      }
      if (p.files.length > MAX_FILES) out.push(`- _…외 ${p.files.length - MAX_FILES}개_`);
      out.push('');
    }

    if (p.commands.length) {
      out.push(`### 실행한 명령 (${p.commands.length})`);
      for (const c of p.commands.slice(0, MAX_COMMANDS)) out.push(`- \`${truncate(c, 100)}\``);
      if (p.commands.length > MAX_COMMANDS) out.push(`- _…외 ${p.commands.length - MAX_COMMANDS}개_`);
      out.push('');
    }

    out.push('---');
    out.push('');
  }

  out.push('_추출형 리포트 — 코드/명령 기록에서 자동 생성 (AI 윤문 전 원본)_');
  out.push('');
  return out.join('\n');
}
