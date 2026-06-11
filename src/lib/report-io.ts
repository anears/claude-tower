import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderReportMarkdown, type DailyReport } from './daily-report.js';
import { polishReportInCmux } from './cmux.js';

// Side-effecting glue for the daily report: save the markdown to the dashboard
// machine, and (optionally) hand it to a fresh local cmux session for
// natural-language polishing. The polish path launches an interactive `claude`
// (no `-p`) — the user's subscription, no metered API cost.

const REPORT_DIR = join(homedir(), '.agent-view', 'reports');

export function reportFileName(label: string): string {
  return `daily-${label}.md`;
}

// Save the report to the dashboard host (where the user is sitting). Returns the
// absolute path written.
export async function saveReportLocally(report: DailyReport): Promise<string> {
  await mkdir(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, reportFileName(report.dateLabel));
  await writeFile(path, renderReportMarkdown(report), 'utf-8');
  return path;
}

// Save the report, then open a new cmux workspace whose claude reads it and
// rewrites it as a polished work log. Returns a flash message for the UI.
export async function polishReport(report: DailyReport): Promise<string> {
  let path: string;
  try {
    path = await saveReportLocally(report);
  } catch (err) {
    return `윤문 실패 — 파일 저장 오류: ${(err as Error).message}`;
  }
  const res = await polishReportInCmux(path, report.dateLabel);
  return res.ok ? res.message : `윤문 불가: ${res.message}`;
}
