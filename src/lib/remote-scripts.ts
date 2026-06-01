// Remote enumeration scripts and their output parser, centralized so the
// "remote contract" (what we run over SSH and how we read it back) lives in one
// place. `pyCommand` (remote.ts) wraps these for safe transport; it is not
// re-exported here. The script bodies are moved verbatim from sessions.ts /
// liveness.ts — do not edit their logic without matching the parser.

// Emits one TSV row per session on the remote:
//   mtime <tab> size <tab> path <tab> sessionId <tab> cwd <tab> gitBranch <tab> aiTitle
export const LIST_SCRIPT = `import os, json, glob, sys
from itertools import islice
def clean(s): return str(s).replace('\\t', ' ').replace('\\n', ' ').replace('\\r', ' ')
base = os.path.expanduser('~/.claude/projects')
out = []
for f in glob.glob(os.path.join(base, '*', '*.jsonl')):
    try:
        st = os.stat(f)
    except OSError:
        continue
    cwd = ''; branch = ''; sid = ''; title = ''
    try:
        with open(f, 'r', errors='replace') as fh:
            for line in islice(fh, 120):
                line = line.strip()
                if not line: continue
                try: o = json.loads(line)
                except Exception: continue
                if not sid and o.get('sessionId'): sid = o['sessionId']
                if not cwd and o.get('cwd'): cwd = o['cwd']
                if not branch and o.get('gitBranch'): branch = o['gitBranch']
                if o.get('aiTitle'): title = o['aiTitle']
    except Exception:
        pass
    out.append('\\t'.join([str(st.st_mtime), str(st.st_size), f, sid, clean(cwd), clean(branch), clean(title)]))
sys.stdout.write('\\n'.join(out))
`;

// Lists every live `claude` process with its cwd and tmux pane target (if any).
// Output: "<pid>|<cwd>|<tmuxTarget>" per line.
// Linux/proc variant — used for remote servers and for a local server on Linux.
export const ENUM_SCRIPT = `import os, sys
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
export const DARWIN_ENUM_SCRIPT = `import os, json, glob, subprocess
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

export interface EnumProc {
  pid: number;
  cwd: string;
  target: string; // tmux target within the server ("<session>:<window>.<pane>"), or ''
}

// Parse one "<pid>|<cwd>|<target>" line from the enum scripts. Returns null for
// blank or malformed lines (no pipes, non-numeric pid) so noise is dropped.
export function parseEnumLine(line: string): EnumProc | null {
  const t = line.trim();
  if (!t) return null;
  const i1 = t.indexOf('|');
  const i2 = t.indexOf('|', i1 + 1);
  if (i1 < 0 || i2 < 0) return null;
  const pid = parseInt(t.slice(0, i1), 10);
  if (Number.isNaN(pid)) return null;
  return { pid, cwd: t.slice(i1 + 1, i2), target: t.slice(i2 + 1) };
}
