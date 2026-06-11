// Open a Claude Code session in a real cmux workspace. Reuses an existing
// workspace if we already opened this session, otherwise spawns a new one
// running `ssh -t <host> tmux attach -t ...` so the user lands inside the
// real Claude Code TUI (with proper markdown / tool / streaming rendering).
//
// Identity is tracked via the workspace's `description` field (cmux supports
// `--description` on new-workspace and surfaces it back in list-workspaces).
// That decouples our tag from the user-visible `title`, which they may rename.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerConfig } from '../config.js';
import type { SessionInfo } from '../types/message.js';
import { parseTmuxTarget, type TmuxTarget } from './tmux-target.js';
import { remoteShellCommand } from './shell-command.js';
import { buildAttachInner, buildNewSessionInner } from './tmux-launch.js';

const execFileP = promisify(execFile);

const TAG_PREFIX = 'agent-view:claude:';
const CMUX_TIMEOUT_MS = 5_000;

export interface OpenResult {
  ok: boolean;
  action: 'focused-existing' | 'opened-new' | 'no-tmux' | 'cmux-unavailable' | 'error';
  message: string;
}

export async function cmuxAvailable(): Promise<boolean> {
  try {
    await execFileP('cmux', ['ping'], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

interface WorkspaceLite {
  ref: string;
  title: string;
  description: string | null;
}

async function listWorkspaces(): Promise<WorkspaceLite[]> {
  try {
    const { stdout } = await execFileP('cmux', ['list-workspaces', '--json'], { timeout: CMUX_TIMEOUT_MS });
    const data = JSON.parse(stdout) as { workspaces?: unknown[] };
    const arr = Array.isArray(data.workspaces) ? data.workspaces : [];
    return arr.map((w) => {
      const o = (w ?? {}) as { ref?: unknown; title?: unknown; description?: unknown };
      return {
        ref: typeof o.ref === 'string' ? o.ref : '',
        title: typeof o.title === 'string' ? o.title : '',
        description: typeof o.description === 'string' ? o.description : null,
      };
    });
  } catch {
    return [];
  }
}

async function selectWorkspace(ref: string): Promise<void> {
  await execFileP('cmux', ['select-workspace', '--workspace', ref], { timeout: CMUX_TIMEOUT_MS });
}

async function newWorkspace(args: {
  name: string;
  description: string;
  command: string;
}): Promise<void> {
  await execFileP(
    'cmux',
    [
      'new-workspace',
      '--name',
      args.name,
      '--description',
      args.description,
      '--command',
      args.command,
      '--focus',
      'true',
    ],
    { timeout: CMUX_TIMEOUT_MS },
  );
}

// Wrap the attach command for a remote host. Unlike the new/resume paths, the
// attach uses a *bare* `ssh -t <host>` (no -i/-p, no `bash -lc`) so the tmux
// select/attach chain runs directly in the user's shell — relying on ~/.ssh/
// config like the original. tmux refs are digits + ':' + '.' so quoting is safe.
function attachCommand(host: string, inner: string): string {
  return host === 'local' ? inner : `ssh -t ${host} '${inner}'`;
}

function workspaceTitle(session: SessionInfo, parsed: TmuxTarget): string {
  const cwdLeaf = (session.cwd || '').split('/').filter(Boolean).slice(-1)[0] ?? 'session';
  return `${parsed.host} · ${cwdLeaf}`;
}

function workspaceTag(session: SessionInfo): string {
  return `${TAG_PREFIX}${session.sessionId}`;
}

export async function openSessionInCmux(
  session: SessionInfo,
  servers: ServerConfig[],
): Promise<OpenResult> {
  if (!(await cmuxAvailable())) {
    return { ok: false, action: 'cmux-unavailable', message: 'cmux CLI 사용 불가' };
  }

  const tag = workspaceTag(session);
  const existing = (await listWorkspaces()).find((w) => w.description === tag);
  if (existing && existing.ref) {
    try {
      await selectWorkspace(existing.ref);
      return { ok: true, action: 'focused-existing', message: `→ ${existing.title || existing.ref}` };
    } catch (e) {
      return { ok: false, action: 'error', message: `포커스 실패: ${(e as Error).message}` };
    }
  }

  // LIVE path — attach to the actual tmux pane the session runs in.
  if (session.tmuxTarget) {
    const parsed = parseTmuxTarget(session.tmuxTarget);
    if (!parsed) {
      return { ok: false, action: 'error', message: `잘못된 tmux 타겟: ${session.tmuxTarget}` };
    }
    try {
      await newWorkspace({
        name: workspaceTitle(session, parsed),
        description: tag,
        command: attachCommand(parsed.host, buildAttachInner(parsed)),
      });
      return { ok: true, action: 'opened-new', message: `▶ attached` };
    } catch (e) {
      return { ok: false, action: 'error', message: `생성 실패: ${(e as Error).message}` };
    }
  }

  // OFFLINE path — resume the session by replaying its JSONL into a new claude.
  return resumeOfflineSession(session, servers, tag);
}

async function resumeOfflineSession(
  session: SessionInfo,
  servers: ServerConfig[],
  tag: string,
): Promise<OpenResult> {
  const server = servers.find((s) => s.name === session.source);
  if (!server) {
    return { ok: false, action: 'error', message: `source 서버 '${session.source}' 미등록` };
  }
  // Reuse cwd from the JSONL. If it contains characters we don't shell-escape,
  // bail rather than silently launching in the wrong directory.
  const cwdCheck = sanitizeCwd(session.cwd ?? '');
  if (!cwdCheck.ok) {
    return { ok: false, action: 'error', message: `cwd 무효: ${cwdCheck.reason}` };
  }
  const cwd = cwdCheck.value || '$HOME';
  const tmuxName = sanitizeTmuxName(`resume-${session.sessionId.slice(0, 8)}`);
  const launch = `${CLAUDE_INVOCATION} --resume ${session.sessionId}`;
  const inner = buildNewSessionInner(cwd, tmuxName, launch);
  const command = server.local ? inner : remoteShellCommand(inner, server);
  const cwdLeaf = (session.cwd || '').split('/').filter(Boolean).slice(-1)[0] ?? session.sessionId.slice(0, 8);
  const title = `${server.name} · ${cwdLeaf}`;
  try {
    await newWorkspace({ name: title, description: tag, command });
    return { ok: true, action: 'opened-new', message: `▶ resumed ${session.sessionId.slice(0, 8)}` };
  } catch (e) {
    return { ok: false, action: 'error', message: `생성 실패: ${(e as Error).message}` };
  }
}

// ---- Launch a brand-new claude session, always inside tmux -----------------
// Goal: future sessions are controllable (i/o keys work) because they live in
// a known tmux session from the start. Builds `tmux new -As <name> claude`
// and runs it via ssh (or locally), in a fresh cmux workspace.

const CLAUDE_INVOCATION = 'claude --dangerously-skip-permissions';

function sanitizeTmuxName(raw: string): string {
  // tmux session names: keep alphanumerics, hyphen, underscore. Replace others.
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || defaultSessionName();
}

export function defaultSessionName(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `claude-${hh}${mm}`;
}

// Allow only safe path characters so we can pass `-c <path>` bare (no quoting
// gymnastics across ssh + bash -lc + tmux). Covers almost all real project
// paths; users with spaces / specials in paths would need to rename or wrap.
const SAFE_CWD = /^[\w./\-~]+$/;

export function sanitizeCwd(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const t = raw.trim();
  if (t === '') return { ok: true, value: '' }; // default = home
  if (!SAFE_CWD.test(t)) {
    return { ok: false, reason: '경로에 허용되지 않는 문자 (스페이스/특수문자 X)' };
  }
  return { ok: true, value: t };
}

function buildNewSessionCommand(server: ServerConfig, sessionName: string, cwd: string): string {
  // Always `cd` before launching tmux:
  // - explicit cwd → cd there; fails loudly if missing
  // - empty cwd → default to $HOME so local and remote behave the same
  //   (without this, local inherits the cmux workspace's caller cwd while
  //    remote `bash -lc` starts at $HOME — confusing asymmetry)
  const targetCwd = cwd || '$HOME';
  const inner = buildNewSessionInner(targetCwd, sessionName, CLAUDE_INVOCATION);
  return server.local ? inner : remoteShellCommand(inner, server);
}

// ---- Daily-report AI polish -------------------------------------------------
// Launch a fresh local cmux workspace running an interactive `claude` seeded
// with a prompt to read the saved report file and rewrite it. Interactive mode
// (no `-p`) so it runs on the user's subscription, not metered API. The report
// is referenced by absolute path, so cwd is irrelevant and no shell-fragile
// tmux wrapping is needed — claude reads the file from anywhere.

function shSingleQuote(s: string): string {
  // POSIX-safe single quoting: close, escaped-quote, reopen for any embedded '.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function polishReportInCmux(reportPath: string, dateLabel: string): Promise<OpenResult> {
  if (!(await cmuxAvailable())) {
    return { ok: false, action: 'cmux-unavailable', message: 'cmux CLI 사용 불가' };
  }
  // The polish session writes its result to a sibling .polished.md (Write runs
  // without a prompt under --dangerously-skip-permissions), so the cleaned-up
  // report is saved automatically, not just shown on screen.
  const outPath = reportPath.replace(/\.md$/, '') + '.polished.md';
  const prompt =
    `${reportPath} 파일을 읽고, 이 일일 업무 기록을 한국어 근무 보고서로 간결하게 정리해줘. ` +
    `핵심 성과 위주로 항목화하고, 단순 파일/명령 나열은 묶어서 요약해줘. ` +
    `정리한 최종 결과는 반드시 ${outPath} 파일로 저장(Write)해줘.`;
  const command = `${CLAUDE_INVOCATION} ${shSingleQuote(prompt)}`;
  try {
    await newWorkspace({
      name: `윤문 · ${dateLabel}`,
      description: `agent-view:report-polish:${dateLabel}`,
      command,
    });
    return { ok: true, action: 'opened-new', message: `▶ 윤문 세션 시작 · 완료 후 ${outPath}에 저장됨` };
  } catch (e) {
    return { ok: false, action: 'error', message: `윤문 세션 생성 실패: ${(e as Error).message}` };
  }
}

export async function newSessionInCmux(
  server: ServerConfig,
  rawName?: string,
  rawCwd?: string,
): Promise<OpenResult> {
  if (!(await cmuxAvailable())) {
    return { ok: false, action: 'cmux-unavailable', message: 'cmux CLI 사용 불가' };
  }
  const cwdResult = sanitizeCwd(rawCwd ?? '');
  if (!cwdResult.ok) {
    return { ok: false, action: 'error', message: cwdResult.reason };
  }
  const name = sanitizeTmuxName(rawName || defaultSessionName());
  const command = buildNewSessionCommand(server, name, cwdResult.value);
  const titleSuffix = cwdResult.value ? ` @ ${cwdResult.value.split('/').filter(Boolean).slice(-1)[0] ?? cwdResult.value}` : '';
  const title = `${server.name} · ${name}${titleSuffix}`;
  // Tag prefix differs so we don't conflate "open existing" with "launch new"
  const description = `agent-view:new-claude:${server.name}:${name}`;
  try {
    await newWorkspace({ name: title, description, command });
    return { ok: true, action: 'opened-new', message: `▶ ${title}` };
  } catch (e) {
    return { ok: false, action: 'error', message: `생성 실패: ${(e as Error).message}` };
  }
}
