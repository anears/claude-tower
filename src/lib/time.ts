// Relative-time and path-shortening formatters shared by the session list and
// info panel. Pure, dependency-free.

export function timeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Collapse a long cwd to its trailing two segments (e.g. "…/project/foo").
export function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return '…/' + parts.slice(-2).join('/');
}
