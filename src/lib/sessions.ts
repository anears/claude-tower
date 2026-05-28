import { exec, readRemoteFile } from './ssh.js';
import { parseJsonl, decodeProjectDir } from './parser.js';
import { pyCommand } from './remote.js';
import type { ServerConfig } from '../config.js';
import type { SessionInfo, TranscriptEntry } from '../types/message.js';

// Runs once on the remote and emits one TSV row per session:
// mtime <tab> size <tab> path <tab> sessionId <tab> cwd <tab> gitBranch <tab> aiTitle
const LIST_SCRIPT = `import os, json, glob, sys
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

// The home dir is NFS-shared across the fundus cluster, so the session list is
// cluster-wide — read it from a single server. `liveOn` is filled in later by
// merging per-server liveness (see lib/liveness.ts).
export async function listSessions(server: ServerConfig): Promise<SessionInfo[]> {
  const { stdout, code } = await exec(server, pyCommand(LIST_SCRIPT));
  if (code !== 0) return [];

  const sessions: SessionInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [mtime, size, filePath, sessionId, cwd, gitBranch, aiTitle] = line.split('\t');
    if (!filePath) continue;
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] ?? '';
    const projectDir = parts[parts.length - 2] ?? '';
    sessions.push({
      projectDir,
      cwd: cwd || decodeProjectDir(projectDir),
      gitBranch: gitBranch || undefined,
      aiTitle: aiTitle || undefined,
      sessionId: sessionId || fileName.replace(/\.jsonl$/, ''),
      filePath,
      lastModified: new Date(Number(mtime) * 1000),
      sizeBytes: Number(size),
      liveOn: [],
      source: server.name,
    });
  }
  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return sessions;
}

export async function readTranscript(
  server: ServerConfig,
  filePath: string,
): Promise<TranscriptEntry[]> {
  const content = await readRemoteFile(server, filePath);
  return parseJsonl(content);
}
