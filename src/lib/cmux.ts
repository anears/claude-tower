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
import type { SessionInfo } from '../types/message.js';

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

// tmuxTarget format from liveness: "<host>:<session>:<window>.<pane>"
interface ParsedTarget {
  host: string;
  session: string;
  window: string;
  pane: string;
}

function parseTmuxTarget(t: string): ParsedTarget | null {
  const i = t.indexOf(':');
  if (i < 0) return null;
  const host = t.slice(0, i);
  const rest = t.slice(i + 1);
  const m = rest.match(/^([^:]+):(\d+)\.(\d+)$/);
  if (!m) return null;
  return { host, session: m[1]!, window: m[2]!, pane: m[3]! };
}

// Build the shell command we feed to cmux --command. cmux just types this
// string + Enter into a fresh terminal, so it runs in the user's shell.
function buildLaunchCommand(p: ParsedTarget): string {
  // Three separate tmux invocations chained with `;` are easier to quote than
  // tmux's internal `\;` chain. select-* run *outside* the attach so they
  // pre-position the active window/pane before `attach` blocks.
  const setup = `tmux select-window -t ${p.session}:${p.window}; tmux select-pane -t ${p.session}:${p.window}.${p.pane}`;
  const attach = `tmux attach -t ${p.session}`;
  if (p.host === 'local') return `${setup}; ${attach}`;
  // Wrap the remote command in single quotes; tmux refs are digits + ':' + '.' so quoting is safe.
  return `ssh -t ${p.host} '${setup}; ${attach}'`;
}

function workspaceTitle(session: SessionInfo, parsed: ParsedTarget): string {
  const cwdLeaf = (session.cwd || '').split('/').filter(Boolean).slice(-1)[0] ?? 'session';
  return `${parsed.host} · ${cwdLeaf}`;
}

function workspaceTag(session: SessionInfo): string {
  return `${TAG_PREFIX}${session.sessionId}`;
}

export async function openSessionInCmux(session: SessionInfo): Promise<OpenResult> {
  if (!session.tmuxTarget) {
    return { ok: false, action: 'no-tmux', message: '이 세션은 tmux 밖이라 열 수 없음' };
  }
  if (!(await cmuxAvailable())) {
    return { ok: false, action: 'cmux-unavailable', message: 'cmux CLI 사용 불가' };
  }
  const parsed = parseTmuxTarget(session.tmuxTarget);
  if (!parsed) {
    return { ok: false, action: 'error', message: `잘못된 tmux 타겟: ${session.tmuxTarget}` };
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

  try {
    await newWorkspace({
      name: workspaceTitle(session, parsed),
      description: tag,
      command: buildLaunchCommand(parsed),
    });
    return { ok: true, action: 'opened-new', message: `▶ cmux 워크스페이스 생성됨` };
  } catch (e) {
    return { ok: false, action: 'error', message: `생성 실패: ${(e as Error).message}` };
  }
}
