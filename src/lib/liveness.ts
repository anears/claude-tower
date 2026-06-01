import { exec } from './ssh.js';
import { pyCommand } from './remote.js';
import { ENUM_SCRIPT, DARWIN_ENUM_SCRIPT, parseEnumLine, type EnumProc } from './remote-scripts.js';
import { formatHostTarget } from './tmux-target.js';
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
// the pane target for send-keys. The platform scripts and the "<pid>|<cwd>|
// <target>" line parser live in remote-scripts.ts.
async function enumerateClaude(server: ServerConfig): Promise<EnumProc[]> {
  const out: EnumProc[] = [];
  // Local Mac has no /proc — drive enumeration from the session registry instead.
  const script = server.local && process.platform === 'darwin' ? DARWIN_ENUM_SCRIPT : ENUM_SCRIPT;
  try {
    const { stdout } = await exec(server, pyCommand(script));
    for (const line of stdout.split('\n')) {
      const p = parseEnumLine(line);
      if (p) out.push(p);
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
      if (p.target) cur.tmuxTarget = formatHostTarget(name, p.target);
      map.set(sessionId, cur);
    }
  }
  return map;
}
