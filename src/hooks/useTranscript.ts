import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readTranscript } from '../lib/sessions.js';
import { usePolling } from './usePolling.js';
import { POLLING_INTERVALS } from '../constants.js';
import type { ServerConfig } from '../config.js';
import type { SessionInfo, TranscriptEntry } from '../types/message.js';

export interface UseTranscript {
  entries: TranscriptEntry[];
  loading: boolean;
  error?: string;
  scrollOffset: number;
  setScrollOffset: Dispatch<SetStateAction<number>>;
  appendOptimistic: (entry: TranscriptEntry) => void;
  forceTail: () => void;
}

// Transcript for the selected session: an immediate load on selection change
// (with cancellation + filePath race guard), plus a flicker-free background
// tail that runs only while the session is live and the user is at the bottom.
// `sourceServer` is the server whose filesystem hosts the JSONL (session.source).
export function useTranscript(
  sourceServer: ServerConfig | undefined,
  session: SessionInfo | undefined,
): UseTranscript {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);

  // Refs so the background poll / async callbacks always see current values
  // without being included in effect deps (which would re-subscribe the poll).
  const scrollRef = useRef(0);
  scrollRef.current = scrollOffset;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sourceRef = useRef(sourceServer);
  sourceRef.current = sourceServer;

  // Fetch immediately when the selected session changes. Keyed on filePath only
  // (matching the original) so a config change alone doesn't refetch.
  useEffect(() => {
    if (!sourceServer || !session) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const filePath = session.filePath;
    setScrollOffset(0); // new session → back to tailing latest
    setLoading(true);
    setError(undefined);
    readTranscript(sourceServer, filePath)
      .then((t) => {
        if (!cancelled && sessionRef.current?.filePath === filePath) {
          setEntries(t);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError((err as Error).message ?? String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.filePath]);

  // Background tail — only while live, and only when the user is at the bottom
  // (scrollOffset 0). No loading flag so output appends without flicker.
  usePolling(async () => {
    const s = sessionRef.current;
    if (!s || s.liveOn.length === 0) return;
    if (scrollRef.current > 0) return; // user is reading old content
    const src = sourceRef.current;
    if (!src) return;
    const filePath = s.filePath;
    const t = await readTranscript(src, filePath);
    if (sessionRef.current?.filePath === filePath && scrollRef.current === 0) {
      setEntries(t);
    }
  }, POLLING_INTERVALS.transcript);

  // Optimistic echo — show a just-sent message immediately, like a chat app.
  const appendOptimistic = (entry: TranscriptEntry): void => {
    setEntries((prev) => [...prev, entry]);
  };

  // Jump to latest and force an immediate refresh (polling is paused while
  // scrolled, so 'G' must fetch right away).
  const forceTail = (): void => {
    setScrollOffset(0);
    const s = sessionRef.current;
    const src = sourceRef.current;
    if (src && s) {
      const filePath = s.filePath;
      void readTranscript(src, filePath).then((t) => {
        if (sessionRef.current?.filePath === filePath) setEntries(t);
      });
    }
  };

  return { entries, loading, error, scrollOffset, setScrollOffset, appendOptimistic, forceTail };
}
