import { useState } from 'react';
import { listSessions } from '../lib/sessions.js';
import { usePolling } from './usePolling.js';
import { POLLING_INTERVALS } from '../constants.js';
import type { Config } from '../config.js';
import type { SessionInfo } from '../types/message.js';

export interface UseSessions {
  allSessions: SessionInfo[];
  reload: (cfg?: Config) => Promise<SessionInfo[]>;
}

// Cluster-wide session list. Fetches from every configured server in parallel
// and dedupes by sessionId — cluster servers sharing NFS return identical
// entries, so the first one wins (its `source` marks where transcript reads go).
// Local sessions stay distinct (different filesystem). Sorted newest-first.
//
// Owns the slow background refresh; the *initial* load is driven by the caller
// (App) so it can sequence sessions → liveness → rate-limits and gate the
// loading screen on all three.
export function useSessions(config: Config): UseSessions {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);

  const reload = async (cfg: Config = config): Promise<SessionInfo[]> => {
    if (cfg.servers.length === 0) return [];
    const results = await Promise.all(
      cfg.servers.map(async (s) => {
        try {
          return await listSessions(s);
        } catch {
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    const merged: SessionInfo[] = [];
    for (const list of results) {
      for (const s of list) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        merged.push(s);
      }
    }
    merged.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    setAllSessions(merged);
    return merged;
  };

  usePolling(async () => {
    await reload();
  }, POLLING_INTERVALS.sessions);

  return { allSessions, reload };
}
