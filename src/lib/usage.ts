import type { TranscriptEntry } from '../types/message.js';

// Rate limits live in their own module (`./rate-limits`) so this file stays
// focused on session usage / cost / pricing. Re-export for backward compat.
export { getRateLimits, type RateLimits, type RateWindow } from './rate-limits.js';

// ---- Model info & cost ------------------------------------------------------
// Approximate public Anthropic pricing (USD per 1M tokens). These are estimates
// for an at-a-glance number — not authoritative billing.

export interface ModelInfo {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  contextMax: number;
}

const PRICES: Record<string, ModelInfo> = {
  // Opus 4.7+ have a 1M context window. Each such version needs an explicit
  // entry — the longest-prefix match below would otherwise fall through to the
  // generic `claude-opus` (200k). Add new 1M Opus versions here.
  'claude-opus-4-8': { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5, contextMax: 1_000_000 },
  'claude-opus-4-7': { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5, contextMax: 1_000_000 },
  // Opus default 200k
  'claude-opus': { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5, contextMax: 200_000 },
  'claude-sonnet': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3, contextMax: 200_000 },
  'claude-haiku': { input: 0.8, output: 4, cacheCreation: 1.0, cacheRead: 0.08, contextMax: 200_000 },
};

const UNKNOWN: ModelInfo = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, contextMax: 200_000 };

export function modelInfo(model: string): ModelInfo {
  if (!model) return UNKNOWN;
  if (PRICES[model]) return PRICES[model];
  // longest-prefix match
  for (const k of Object.keys(PRICES).sort((a, b) => b.length - a.length)) {
    if (model.startsWith(k)) return PRICES[k]!;
  }
  return UNKNOWN;
}

export function shortModel(model: string): string {
  // claude-opus-4-7 -> opus-4-7; claude-haiku-4-5-20251001 -> haiku-4-5
  if (!model) return '?';
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}.*$/, '')
    .replace(/^([^-]+-\d+-\d+).*$/, '$1');
}

// ---- Session usage from transcript -----------------------------------------

export interface SessionUsage {
  model: string;
  contextTokens: number; // last turn's total prompt size
  contextMax: number;
  totalCost: number; // USD estimate, all turns
}

export function computeSessionUsage(entries: TranscriptEntry[]): SessionUsage {
  let model = '';
  let contextTokens = 0;
  let totalCost = 0;
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const m = e.message.model;
    if (m && m !== '<synthetic>') model = m;
    const u = e.message.usage;
    if (!u) continue;
    const info = modelInfo(model);
    const inT = u.input_tokens ?? 0;
    const outT = u.output_tokens ?? 0;
    const ccT = u.cache_creation_input_tokens ?? 0;
    const crT = u.cache_read_input_tokens ?? 0;
    totalCost += (inT * info.input + outT * info.output + ccT * info.cacheCreation + crT * info.cacheRead) / 1_000_000;
    contextTokens = inT + ccT + crT; // last assistant's total prompt
  }
  return { model, contextTokens, contextMax: modelInfo(model).contextMax, totalCost };
}

// ---- Formatting helpers -----------------------------------------------------

export function bar(ratio: number, width: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

// Utilization → traffic-light color. Input is a 0..100 percentage. Shared by
// the usage bar and the per-session context meter (which passes ratio * 100).
export function pctColor(p: number): string {
  if (p >= 90) return 'red';
  if (p >= 70) return 'yellow';
  return 'green';
}

export function untilReset(at: Date | null | undefined): string {
  if (!at) return '';
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}
