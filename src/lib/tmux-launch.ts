import type { TmuxTarget } from './tmux-target.js';

// Inner shell-command builders for the tmux launch paths. Each returns the
// command string verbatim — the caller decides whether to run it locally or
// wrap it for a remote server (see shell-command.ts). Quoting is intentionally
// minimal and must stay byte-identical to the originals in cmux.ts.

// Attach to an existing pane: pre-position window/pane *outside* the attach
// (select-* run before `attach` blocks), then attach to the session.
export function buildAttachInner(t: TmuxTarget): string {
  const setup = `tmux select-window -t ${t.session}:${t.window}; tmux select-pane -t ${t.session}:${t.window}.${t.pane}`;
  const attach = `tmux attach -t ${t.session}`;
  return `${setup}; ${attach}`;
}

// Start (or attach to) a tmux session running `command`, after cd-ing to `cwd`.
// `command` is the full launch invocation (e.g. `claude ...` with optional
// flags). `cwd` should already be sanitized / defaulted (e.g. to `$HOME`).
export function buildNewSessionInner(cwd: string, sessionName: string, command: string): string {
  return `cd ${cwd} && tmux new -As ${sessionName} ${command}`;
}
