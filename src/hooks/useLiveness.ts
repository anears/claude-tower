import { useRef, useState } from 'react';
import { getLiveness, type Liveness } from '../lib/liveness.js';
import { usePolling } from './usePolling.js';
import { POLLING_INTERVALS } from '../constants.js';
import type { Config } from '../config.js';
import type { SessionInfo } from '../types/message.js';

export interface UseLiveness {
  liveness: Map<string, Liveness>;
  reload: (sessions?: SessionInfo[], cfg?: Config) => Promise<void>;
}

// Per-server liveness (which sessions are running where, status, tmux target).
// Polls fast. The latest session list is tracked via a ref so the background
// poll always maps against current sessions without re-subscribing; callers can
// also pass an explicit list (e.g. the freshly-loaded list during initial load
// or right after a server add/delete).
export function useLiveness(config: Config, sessions: SessionInfo[]): UseLiveness {
  const [liveness, setLiveness] = useState<Map<string, Liveness>>(new Map());
  const sessionsRef = useRef<SessionInfo[]>(sessions);
  sessionsRef.current = sessions;

  const reload = async (
    sess: SessionInfo[] = sessionsRef.current,
    cfg: Config = config,
  ): Promise<void> => {
    setLiveness(await getLiveness(cfg.servers, sess));
  };

  usePolling(() => reload(), POLLING_INTERVALS.liveness);

  return { liveness, reload };
}
