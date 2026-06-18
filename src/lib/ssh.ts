import { Client } from 'ssh2';
import { readFile, readFile as fsReadFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../config.js';

const pool = new Map<string, Promise<Client>>();

// Node's fs does not expand `~`, so a key path like `~/.ssh/key.pem` (or a
// hand-edited config) would fail with ENOENT. Expand a leading `~/` ourselves.
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

async function connect(server: ServerConfig): Promise<Client> {
  const client = new Client();
  const agentSock = process.env.SSH_AUTH_SOCK;

  // Load the private key if a path is given. A missing/unreadable key file is
  // only fatal when there's no SSH agent to fall back on — that lets agent-only
  // users add a server without a key file present.
  let privateKey: Buffer | undefined;
  if (server.privateKeyPath) {
    try {
      privateKey = await readFile(expandTilde(server.privateKeyPath));
    } catch (err) {
      if (!agentSock) throw err;
    }
  }

  return new Promise((resolve, reject) => {
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: server.host,
        port: server.port,
        username: server.username,
        // Try the SSH agent (if running) and the explicit key. ssh2 attempts
        // the available public-key methods until one authenticates.
        agent: agentSock || undefined,
        privateKey,
        passphrase: server.passphrase || undefined,
        keepaliveInterval: 30_000,
        readyTimeout: 15_000,
      });
  });
}

export async function getClient(server: ServerConfig): Promise<Client> {
  if (server.local) throw new Error('getClient is not supported for local servers');
  const key = `${server.username}@${server.host}:${server.port}`;
  let p = pool.get(key);
  if (!p) {
    p = connect(server).catch((err) => {
      pool.delete(key);
      throw err;
    });
    pool.set(key, p);
  }
  return p;
}

// Run the command locally via the user's shell (no SSH). Used for the local
// "server" entry so the dashboard can include the user's own machine.
async function execLocal(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf-8')));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on('error', (err) => resolve({ stdout, stderr: stderr + String(err), code: 1 }));
  });
}

export async function exec(
  server: ServerConfig,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (server.local) return execLocal(command);
  const client = await getClient(server);
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code: number) => resolve({ stdout, stderr, code: code ?? 0 }))
        .on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
        .stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    });
  });
}

export async function readRemoteFile(server: ServerConfig, path: string): Promise<string> {
  if (server.local) {
    // `path` may contain a leading `~/` — bash handles it via `cat`.
    const { stdout, stderr, code } = await execLocal(`cat "${path}"`);
    if (code !== 0) throw new Error(`Failed to read ${path}: ${stderr.trim() || 'exit ' + code}`);
    return stdout;
  }
  const { stdout, stderr, code } = await exec(server, `cat "${path}"`);
  if (code !== 0) throw new Error(`Failed to read ${path}: ${stderr}`);
  return stdout;
}

// Map a raw connection error to a short, human-readable Korean reason.
function describeSshError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  const msg = (e?.message ?? String(err)).trim();
  switch (e?.code) {
    case 'ENOENT':
      return `개인키 파일 없음: ${msg}`;
    case 'ENOTFOUND':
      return '호스트를 찾을 수 없음 (주소/DNS 확인)';
    case 'ECONNREFUSED':
      return '연결 거부됨 (포트/방화벽 확인)';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return '연결 시간 초과 (호스트 도달 불가)';
  }
  if (/authentication/i.test(msg)) return '인증 실패 (사용자명/키 확인)';
  if (/handshake|timed out/i.test(msg)) return '핸드셰이크 시간 초과';
  return msg;
}

// Verify the server is reachable over SSH and can run a command. Returns null
// on success, or a short human-readable failure reason. Run before persisting a
// newly added server so an unreachable host never lands in the list. A
// successful check warms the connection pool, so the follow-up reload reuses it.
export async function checkConnection(server: ServerConfig): Promise<string | null> {
  if (server.local) return null;
  try {
    const { code, stderr } = await exec(server, 'echo agent-view-ok');
    if (code !== 0) {
      const tail = stderr.trim();
      return `명령 실행 실패 (exit ${code})${tail ? `: ${tail}` : ''}`;
    }
    return null;
  } catch (err) {
    return describeSshError(err);
  }
}

export async function disconnectAll(): Promise<void> {
  for (const [key, p] of pool) {
    try {
      const client = await p;
      client.end();
    } catch {
      // ignore
    }
    pool.delete(key);
  }
}

// Re-export so callers don't need to import from fs directly when they have a server.
export { fsReadFile };
