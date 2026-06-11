import { loadConfig } from './config.js';
import { listSessions, readTranscript } from './lib/sessions.js';
import { getLiveness } from './lib/liveness.js';
import { disconnectAll } from './lib/ssh.js';
import { computeTranscriptStats } from './lib/transcript-stats.js';
import { dayWindow, extractSessionActivity, buildDailyReport } from './lib/daily-report.js';
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

  // Daily work report (today) — exercise the extractor end-to-end. The home is
  // NFS-shared, so every transcript is readable from the primary server.
  const win = dayWindow(new Date());
  const todays = sessions.filter((s) => s.lastModified.getTime() >= win.start.getTime());
  const acts = [];
  for (const s of todays.slice(0, 20)) {
    try {
      const entries = await readTranscript(primary, s.filePath);
      const a = extractSessionActivity(s, entries, win);
      if (a) acts.push(a);
    } catch {
      // skip unreadable transcript
    }
  }
  const report = buildDailyReport(win.label, acts, new Date());
  console.log(
    `\nDaily report ${report.dateLabel}: ${report.totals.sessions} sessions · ` +
      `${report.totals.projects} projects · ${report.totals.turns} turns · ` +
      `${report.totals.files} files · ${report.totals.commands} cmds`,
  );
  for (const p of report.projects.slice(0, 5)) {
    console.log(`  ${p.project}: ${p.turns} turns, ${p.files.length} files, ${p.commands.length} cmds`);
  }

  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
