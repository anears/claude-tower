// Single codec for the host-qualified tmux target string used across the app:
//   "<host>:<session>:<window>.<pane>"   e.g. "f3:0:1.1"
//
// Three views of this string existed inline in three modules; they all live
// here now:
//   - cmux.ts needs the fully structured {host,session,window,pane} (attach).
//   - liveness.ts builds the host-qualified string from a server name + a
//     bare "<session>:<window>.<pane>" produced on the remote.
//   - tmux.ts only needs to split off the host to route send-keys.

export interface TmuxTarget {
  host: string;
  session: string;
  window: string;
  pane: string;
}

// Parse a fully-qualified target. Returns null on anything malformed (matching
// cmux.ts's original behavior: split at the first ':' for the host, then the
// remainder must be "<session>:<window>.<pane>" with numeric window/pane).
export function parseTmuxTarget(input: string): TmuxTarget | null {
  const i = input.indexOf(':');
  if (i < 0) return null;
  const host = input.slice(0, i);
  const rest = input.slice(i + 1);
  const m = rest.match(/^([^:]+):(\d+)\.(\d+)$/);
  if (!m) return null;
  return { host, session: m[1]!, window: m[2]!, pane: m[3]! };
}

// Compose the host-qualified string from a server name and the bare
// "<session>:<window>.<pane>" the remote enumeration emits. Byte-identical to
// the previous inline `${host}:${sessionWindowPane}`.
export function formatHostTarget(host: string, sessionWindowPane: string): string {
  return `${host}:${sessionWindowPane}`;
}

// Split off just the host, returning the remaining tmux target. Mirrors
// tmux.ts's original indexOf(':')/slice; returns null when there's no ':' so
// callers can reproduce their "malformed target" error.
export function splitHostTarget(hostTarget: string): { host: string; target: string } | null {
  const sep = hostTarget.indexOf(':');
  if (sep < 0) return null;
  return { host: hostTarget.slice(0, sep), target: hostTarget.slice(sep + 1) };
}
