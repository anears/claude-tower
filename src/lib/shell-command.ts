import type { ServerConfig } from '../config.js';

// SSH command-string builders shared by the cmux launch paths. These produce
// the exact strings cmux types into a fresh terminal, so quoting must be stable
// — do not change escaping here without re-verifying every generated command.

// Explicit ssh prefix so it works regardless of ~/.ssh/config. Forces a pty
// (-t) because tmux needs one. Adds -i/-p only when configured.
export function sshPrefix(server: ServerConfig): string {
  const parts = ['ssh', '-t'];
  if (server.privateKeyPath) parts.push('-i', server.privateKeyPath);
  if (server.port && server.port !== 22) parts.push('-p', String(server.port));
  parts.push(server.username ? `${server.username}@${server.host}` : server.host);
  return parts.join(' ');
}

// Wrap an inner shell command to run on a remote server through a login shell.
// `bash -lc` forces a login shell so PATH (claude is in ~/.local/bin) matches
// the user's interactive remote shell.
export function remoteShellCommand(inner: string, server: ServerConfig): string {
  return `${sshPrefix(server)} 'bash -lc "${inner}"'`;
}
