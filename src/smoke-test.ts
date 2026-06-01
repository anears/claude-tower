import { loadConfig } from './config.js';
import { listSessions, readTranscript } from './lib/sessions.js';
import { getLiveness } from './lib/liveness.js';
import { disconnectAll } from './lib/ssh.js';
import { computeTranscriptStats } from './lib/transcript-stats.js';
import type { SessionInfo } from './types/message.js';

async function main() {
  const config = await loadConfig();
  console.log(`Servers: ${config.servers.map((s) => s.name).join(', ')}`);
  const primary = config.servers[0];
  if (!primary) {
    console.log('No servers configured.');
    return;
  }

  const sessions = await listSessions(primary);
  const liveness = await getLiveness(config.servers, sessions);
  for (const s of sessions) {
    const lv = liveness.get(s.sessionId);
    s.liveOn = lv?.liveOn ?? [];
    s.status = lv?.status;
    s.tmuxTarget = lv?.tmuxTarget;
  }

  console.log(`\nTotal sessions (deduped, cluster-wide): ${sessions.length}`);
  const liveSessions = sessions.filter((s) => s.liveOn.length > 0);
  console.log(`Live sessions: ${liveSessions.length}`);
  for (const s of liveSessions) {
    console.log(
      `  ▶ ${s.liveOn.join(',')} [${s.status ?? '?'}] tmux=${s.tmuxTarget ?? '(none)'} ${s.cwd}${s.gitBranch ? ` (${s.gitBranch})` : ''}`,
    );
  }

  console.log(`\nTop 8 by recency:`);
  sessions.slice(0, 8).forEach((s: SessionInfo, i: number) => {
    const live = s.liveOn.length > 0 ? `▶${s.liveOn.join(',')}/${s.status ?? '?'}` : 'offline';
    console.log(`  [${i}] ${live.padEnd(14)} ${s.aiTitle ?? '(no title)'}`);
    console.log(`        ${s.cwd}${s.gitBranch ? ` (${s.gitBranch})` : ''}`);
  });

  if (sessions[0]) {
    const entries = await readTranscript(primary, sessions[0].filePath);
    const { turns, outTokens } = computeTranscriptStats(entries);
    console.log(
      `\nDetail of [0]: ${entries.length} entries · ${turns} turns · ${outTokens} out-tokens · title="${sessions[0].aiTitle ?? ''}"`,
    );
  }

  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
