import { Client } from 'ssh2';
import { readFile, readFile as fsReadFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ServerConfig } from '../config.js';

const pool = new Map<string, Promise<Client>>();

async function connect(server: ServerConfig): Promise<Client> {
  const client = new Client();
  const privateKey = server.privateKeyPath ? await readFile(server.privateKeyPath) : undefined;

  return new Promise((resolve, reject) => {
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey,
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
