// Self-contained client for Claude Code's OAuth usage endpoint. Replaces
// reading the claude-dashboard plugin's cache so the dashboard works on its
// own. Mirrors what that plugin does at a high level:
//   1. Read the OAuth token (macOS Keychain on darwin, ~/.claude/.credentials.json otherwise).
//   2. GET https://api.anthropic.com/api/oauth/usage with the OAuth Bearer header.
//   3. If the Node TLS fingerprint is rejected (403), retry the same request via curl.
//   4. In-memory 5-min cache so we don't pound the endpoint on every poll.
// The endpoint returns metadata only and does not consume usage / cost.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const API_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
const USER_AGENT = 'agent-view/0.1';

export interface RateWindow {
  utilization: number; // 0..100
  resetsAt: Date | null;
}

export interface RateLimits {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  sevenDaySonnet?: RateWindow;
  fetchedAt?: Date;
}

interface CacheEntry {
  data: RateLimits;
  timestamp: number;
}
let cache: CacheEntry | null = null;

// ---- Credentials -----------------------------------------------------------

async function tokenFromKeychain(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 3_000 },
    );
    const creds = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string } };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function tokenFromFile(): Promise<string | null> {
  try {
    const path = join(homedir(), '.claude', '.credentials.json');
    const content = await readFile(path, 'utf-8');
    const creds = JSON.parse(content) as { claudeAiOauth?: { accessToken?: string } };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function getToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    const t = await tokenFromKeychain();
    if (t) return t;
  }
  return tokenFromFile();
}

// ---- HTTP -----------------------------------------------------------------

type FetchResult = { kind: 'ok'; data: unknown } | { kind: 'forbidden' } | { kind: 'error' };

async function viaNode(token: string): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: ctrl.signal,
    });
    if (r.status === 403) return { kind: 'forbidden' };
    if (!r.ok) return { kind: 'error' };
    return { kind: 'ok', data: await r.json() };
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

async function viaCurl(token: string): Promise<FetchResult> {
  try {
    const { stdout } = await execFileP(
      'curl',
      [
        '-s',
        '-w',
        '\n%{http_code}',
        API_URL,
        '-H',
        'Accept: application/json',
        '-H',
        `User-Agent: ${USER_AGENT}`,
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'anthropic-beta: oauth-2025-04-20',
      ],
      { encoding: 'utf-8', timeout: API_TIMEOUT_MS },
    );
    const lines = stdout.trimEnd().split('\n');
    const code = parseInt(lines[lines.length - 1] ?? '', 10);
    const body = lines.slice(0, -1).join('\n');
    if (code >= 200 && code < 300) return { kind: 'ok', data: JSON.parse(body) };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

// ---- Parsing ---------------------------------------------------------------

function toWindow(o: unknown): RateWindow | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as { utilization?: unknown; resets_at?: unknown };
  if (typeof r.utilization !== 'number') return undefined;
  return {
    utilization: r.utilization,
    resetsAt: typeof r.resets_at === 'string' ? new Date(r.resets_at) : null,
  };
}

function toRateLimits(data: unknown): RateLimits {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    fiveHour: toWindow(d.five_hour),
    sevenDay: toWindow(d.seven_day),
    sevenDaySonnet: toWindow(d.seven_day_sonnet),
    fetchedAt: new Date(),
  };
}

// ---- Public ----------------------------------------------------------------

export async function getRateLimits(): Promise<RateLimits | undefined> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) return cache.data;

  const token = await getToken();
  if (!token) return undefined;

  let result = await viaNode(token);
  if (result.kind === 'forbidden') result = await viaCurl(token);
  if (result.kind !== 'ok') return undefined;

  const limits = toRateLimits(result.data);
  cache = { data: limits, timestamp: Date.now() };
  return limits;
}
