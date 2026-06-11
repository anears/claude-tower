import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readTranscript } from '../lib/sessions.js';
import {
  buildDailyReport,
  dayWindow,
  extractSessionActivity,
  type DailyReport,
  type SessionActivity,
} from '../lib/daily-report.js';
import type { ServerConfig } from '../config.js';
import type { SessionInfo } from '../types/message.js';

export interface UseDailyReport {
  open: boolean;
  viewDate: Date; // the calendar day being shown
  report?: DailyReport;
  loading: boolean;
  error?: string;
  scrollOffset: number;
  setScrollOffset: Dispatch<SetStateAction<number>>;
  openReport: () => void; // open at today and generate
  close: () => void;
  shiftDay: (delta: number) => void; // ±1 day, regenerate
  goToday: () => void;
  regenerate: () => void;
}

// Read N transcripts with a bounded concurrency so a busy day doesn't open
// dozens of SSH channels at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// Owns the daily-report overlay state. `allSessions` is the cluster-wide list
// (offline sessions included — a session active earlier today may now be dead)
// and `serverByName` maps a session's `source` to the server hosting its JSONL.
export function useDailyReport(
  allSessions: SessionInfo[],
  serverByName: Map<string, ServerConfig>,
): UseDailyReport {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState<Date>(() => new Date());
  const [report, setReport] = useState<DailyReport | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);

  // Latest inputs via refs so generate() always sees current data without being
  // re-created on every sessions poll.
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const serversRef = useRef(serverByName);
  serversRef.current = serverByName;
  const genId = useRef(0);

  const generate = useCallback(async (date: Date): Promise<void> => {
    const myGen = ++genId.current;
    const win = dayWindow(date);
    setLoading(true);
    setError(undefined);
    setScrollOffset(0);

    // A file can only contain entries from day D if it was last modified on or
    // after D's start — cheap prefilter that bounds the reads to relevant files.
    const candidates = sessionsRef.current.filter((s) => s.lastModified.getTime() >= win.start.getTime());

    try {
      const activities = await mapLimit(candidates, 8, async (s): Promise<SessionActivity | null> => {
        const server = serversRef.current.get(s.source);
        if (!server) return null;
        try {
          const entries = await readTranscript(server, s.filePath);
          return extractSessionActivity(s, entries, win);
        } catch {
          return null; // unreadable transcript shouldn't sink the whole report
        }
      });
      if (myGen !== genId.current) return; // a newer request superseded this one
      const built = buildDailyReport(win.label, activities.filter((a): a is SessionActivity => a !== null), new Date());
      setReport(built);
      setLoading(false);
    } catch (err) {
      if (myGen !== genId.current) return;
      setError((err as Error).message ?? String(err));
      setLoading(false);
    }
  }, []);

  const openReport = useCallback(() => {
    const today = new Date();
    setViewDate(today);
    setOpen(true);
    void generate(today);
  }, [generate]);

  const close = useCallback(() => setOpen(false), []);

  const shiftDay = useCallback(
    (delta: number) => {
      setViewDate((d) => {
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta, 12, 0, 0, 0);
        void generate(next);
        return next;
      });
    },
    [generate],
  );

  const goToday = useCallback(() => {
    const today = new Date();
    setViewDate(today);
    void generate(today);
  }, [generate]);

  const regenerate = useCallback(() => {
    setViewDate((d) => {
      void generate(d);
      return d;
    });
  }, [generate]);

  return {
    open,
    viewDate,
    report,
    loading,
    error,
    scrollOffset,
    setScrollOffset,
    openReport,
    close,
    shiftDay,
    goToday,
    regenerate,
  };
}
