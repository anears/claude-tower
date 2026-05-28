import { exec } from './ssh.js';
import { pyCommand } from './remote.js';
import type { ServerConfig } from '../config.js';
import type { SessionInfo } from '../types/message.js';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  procStart?: string;
}

export interface Liveness {
  liveOn: string[]; // server names where the session is actually running
  status?: string; // busy / idle / running
  tmuxTarget?: string; // "<host>:<session>:<window>.<pane>" for send-keys, if in tmux
}

// ---- Session status registry (~/.claude/sessions/<pid>.json) ----------------
// NFS-shared, so reading it from one server is cluster-wide. Provides the
// busy/idle status, but does NOT list every running session (observed gaps).
const REGISTRY_CMD = `for f in ~/.claude/sessions/*.json; do [ -f "$f" ] && cat "$f" && echo; done 2>/dev/null`;

export async function getSessionRegistry(server: ServerConfig): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = [];
  try {
    const { stdout } = await exec(server, REGISTRY_CMD);
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && o.sessionId && o.pid != null) out.push(o as RegistryEntry);
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  return out;
}

// ---- Running-process enumeration (authoritative liveness) -------------------
// Lists every live `claude` process with its cwd and, if it runs inside tmux,
// the pane target for send-keys. Output: "<pid>|<cwd>|<tmuxTarget>" per line.
//
// Linux/proc variant — used for remote servers and for a local server on Linux.
const ENUM_SCRIPT = `import os, sys
panes = {}
try:
    for line in os.popen("tmux list-panes -a -F '#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null"):
        line = line.strip()
        if not line: continue
        parts = line.split('|', 1)
        if len(parts) == 2: panes[parts[0]] = parts[1]
except Exception:
    pass
def ppid_of(pid):
    try:
        s = open('/proc/' + pid + '/stat').read()
        s = s[s.rfind(')') + 2:]
        return s.split()[1]
    except Exception:
        return None
def find_target(pid):
    cur = pid
    for _ in range(30):
        if not cur or cur == '1': break
        if cur in panes: return panes[cur]
        cur = ppid_of(cur)
    return ''
for d in os.listdir('/proc'):
    if not d.isdigit(): continue
    try:
        comm = open('/proc/' + d + '/comm').read().strip()
    except Exception:
        continue
    if comm != 'claude': continue
    try:
        cwd = os.readlink('/proc/' + d + '/cwd')
    except Exception:
        cwd = ''
    print(d + '|' + cwd + '|' + find_target(d))
`;

// macOS variant — no /proc, so we drive enumeration from the session registry
// and verify with kill(pid, 0). Walks the tmux parent chain via `ps -o ppid=`.
const DARWIN_ENUM_SCRIPT = `import os, json, glob, subprocess
panes = {}
try:
    out = subprocess.check_output(
        ['tmux', 'list-panes', '-a', '-F', '#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}'],
        stderr=subprocess.DEVNULL, text=True,
    )
    for line in out.splitlines():
        line = line.strip()
        if not line: continue
        parts = line.split('|', 1)
        if len(parts) == 2: panes[parts[0]] = parts[1]
except Exception:
    pass
def ppid_of(pid):
    try:
        return subprocess.check_output(['ps', '-o', 'ppid=', '-p', str(pid)],
                                       stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None
def find_target(pid):
    cur = str(pid)
    for _ in range(30):
        if not cur or cur == '1': break
        if cur in panes: return panes[cur]
        cur = ppid_of(cur)
    return ''
for f in glob.glob(os.path.expanduser('~/.claude/sessions/*.json')):
    try:
        with open(f) as fh: o = json.load(fh)
        pid = o.get('pid')
        cwd = o.get('cwd', '')
        if not pid: continue
        try:
            os.kill(int(pid), 0)
        except (ProcessLookupError, PermissionError):
            continue
        print(str(pid) + '|' + cwd + '|' + find_target(pid))
    except Exception:
        pass
`;

interface ClaudeProc {
  pid: number;
  cwd: string;
  target: string; // tmux target within the server, or ''
}

async function enumerateClaude(server: ServerConfig): Promise<ClaudeProc[]> {
  const out: ClaudeProc[] = [];
  // Local Mac has no /proc — drive enumeration from the session registry instead.
  const script = server.local && process.platform === 'darwin' ? DARWIN_ENUM_SCRIPT : ENUM_SCRIPT;
  try {
    const { stdout } = await exec(server, pyCommand(script));
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const i1 = t.indexOf('|');
      const i2 = t.indexOf('|', i1 + 1);
      if (i1 < 0 || i2 < 0) continue;
      const pid = parseInt(t.slice(0, i1), 10);
      if (Number.isNaN(pid)) continue;
      out.push({ pid, cwd: t.slice(i1 + 1, i2), target: t.slice(i2 + 1) });
    }
  } catch {
    // ignore
  }
  return out;
}

// ---- Combined liveness ------------------------------------------------------
// Running-process enumeration is the source of truth for "is it live + where +
// tmux target". The registry enriches it with exact status and sessionId.
// Unregistered processes are mapped to a session by cwd (newest jsonl wins).
export async function getLiveness(
  servers: ServerConfig[],
  sessions: SessionInfo[],
): Promise<Map<string, Liveness>> {
  const primary = servers[0];
  if (!primary) return new Map();

  const registry = await getSessionRegistry(primary);
  const byPid = new Map<number, RegistryEntry>();
  for (const e of registry) byPid.set(e.pid, e);

  // Newest session per cwd (sessions arrive sorted desc by mtime; be defensive).
  const cwdToSession = new Map<string, string>();
  for (const s of [...sessions].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())) {
    if (s.cwd && !cwdToSession.has(s.cwd)) cwdToSession.set(s.cwd, s.sessionId);
  }

  const perServer = await Promise.all(
    servers.map(async (s) => ({ name: s.name, procs: await enumerateClaude(s) })),
  );

  const map = new Map<string, Liveness>();
  for (const { name, procs } of perServer) {
    for (const p of procs) {
      const reg = byPid.get(p.pid);
      const sessionId = reg?.sessionId ?? (p.cwd ? cwdToSession.get(p.cwd) : undefined);
      if (!sessionId) continue; // noise (e.g. sub-agent with no cwd, unmatched)
      const cur = map.get(sessionId) ?? { liveOn: [] as string[] };
      if (!cur.liveOn.includes(name)) cur.liveOn.push(name);
      cur.status = reg?.status ?? cur.status ?? 'running';
      if (p.target) cur.tmuxTarget = `${name}:${p.target}`;
      map.set(sessionId, cur);
    }
  }
  return map;
}
