import { exec } from './ssh.js';
import { splitHostTarget } from './tmux-target.js';
import type { ServerConfig } from '../config.js';

// Send a line of text to a live session's tmux pane, as if typed + Enter.
// `hostTarget` is the host-qualified target produced by liveness, e.g.
// "f3:0:1.1" (host=f3, tmux target=0:1.1). The text is passed base64-encoded
// and decoded into a shell variable, so it can't break out into the command.
// `-l` makes send-keys treat it as a literal string (no key-name parsing).
export async function sendToSession(
  servers: ServerConfig[],
  hostTarget: string,
  text: string,
): Promise<void> {
  const split = splitHostTarget(hostTarget);
  if (!split) throw new Error(`malformed tmux target: ${hostTarget}`);
  const { host, target } = split;
  const server = servers.find((s) => s.name === host);
  if (!server) throw new Error(`no configured server named ${host}`);

  const b64 = Buffer.from(text, 'utf-8').toString('base64');
  const cmd =
    `T=$(echo '${b64}' | base64 -d); ` +
    `tmux send-keys -t '${target}' -l -- "$T"; ` +
    `tmux send-keys -t '${target}' Enter`;
  const { code, stderr } = await exec(server, cmd);
  if (code !== 0) throw new Error(`send-keys failed: ${stderr.trim() || `exit ${code}`}`);
}
