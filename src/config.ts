import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';

const ServerConfig = z.object({
  name: z.string(),
  host: z.string().default('localhost'),
  port: z.number().default(22),
  username: z.string().default(''),
  privateKeyPath: z.string().optional(),
  remoteClaudeDir: z.string().default('~/.claude'),
  local: z.boolean().default(false),
});

const Config = z.object({
  servers: z.array(ServerConfig).default([]),
});

export type ServerConfig = z.infer<typeof ServerConfig>;
export type Config = z.infer<typeof Config>;

const CONFIG_PATH = join(homedir(), '.agent-view', 'config.json');

const LOCAL_SERVER: ServerConfig = {
  name: 'local',
  host: 'localhost',
  port: 22,
  username: '',
  remoteClaudeDir: '~/.claude',
  local: true,
};

const DEFAULT_CONFIG: Config = {
  servers: [
    {
      name: 'f5',
      host: '172.31.10.15',
      port: 22,
      username: 'gitaek.kwon',
      privateKeyPath: join(homedir(), '.ssh', 'id_ed25519'),
      remoteClaudeDir: '~/.claude',
      local: false,
    },
  ],
};

// Ensure a single local server entry always exists at the front of the list.
function ensureLocal(cfg: Config): Config {
  const hasLocal = cfg.servers.some((s) => s.local);
  if (hasLocal) return cfg;
  return { ...cfg, servers: [LOCAL_SERVER, ...cfg.servers] };
}

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return ensureLocal(DEFAULT_CONFIG);
  }
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return ensureLocal(Config.parse(JSON.parse(raw)));
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  // Persist the non-local servers; the local entry is auto-added on load.
  const persisted = { servers: cfg.servers.filter((s) => !s.local) };
  await writeFile(CONFIG_PATH, JSON.stringify(persisted, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
