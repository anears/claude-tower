import type { SessionInfo } from '../types/message.js';

// Session status → display badge (dot glyph, color, short label). Shared by
// SessionInfo and SessionList, which previously each carried an identical copy.
// `verbose` controls only the offline label: SessionInfo always renders the
// label so it shows 'offline'; SessionList renders the label only when live,
// so it passes verbose=false and the offline label is never seen.
export function getSessionBadge(
  session: SessionInfo,
  verbose = true,
): { dot: string; color: string; label: string } {
  if (session.liveOn.length === 0) {
    return { dot: '○', color: 'gray', label: verbose ? 'offline' : '' };
  }
  switch (session.status) {
    case 'busy':
      return { dot: '●', color: 'yellow', label: 'busy' };
    case 'idle':
      return { dot: '●', color: 'green', label: 'idle' };
    default:
      return { dot: '●', color: 'cyan', label: session.status ?? 'live' };
  }
}
