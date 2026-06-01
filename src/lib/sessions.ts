import { exec, readRemoteFile } from './ssh.js';
import { parseJsonl, decodeProjectDir } from './parser.js';
import { pyCommand } from './remote.js';
import { LIST_SCRIPT } from './remote-scripts.js';
import type { ServerConfig } from '../config.js';
import type { SessionInfo, TranscriptEntry } from '../types/message.js';

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
