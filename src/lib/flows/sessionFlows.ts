import { newSessionInCmux, defaultSessionName } from '../cmux.js';
import { exec } from '../ssh.js';
import type { ServerConfig } from '../../config.js';
import type { FlowDef } from '../../hooks/useFlow.js';

// Mirrors cmux.ts's SAFE_CWD: pre-validate the path so we can reject unsafe
// characters before handing off (cmux.ts re-validates too).
const SAFE_CWD = /^[\w./\-~]+$/;

// Resolve a bare relative path (no leading /, ~, .) against the home directory.
// Leaves absolute, ~-prefixed, and explicitly-relative (.) paths untouched.
function anchorHome(v: string): string {
  if (!v || v.startsWith('/') || v.startsWith('~') || v.startsWith('.')) return v;
  return `~/${v}`;
}

// Launch a brand-new claude session inside tmux: server → path → name.
export function newSessionFlow(servers: ServerConfig[]): FlowDef {
  const names = () => servers.map((s) => s.name);
  return {
    kind: 'newSession',
    header: 'New session',
    steps: [
      {
        key: 'server',
        label: () => `서버 (${names().join('|')}, Enter=local)`,
        placeholder: () => 'local',
        transform: (v) => v || 'local',
        validate: (v) => {
          const name = v || 'local';
          return servers.find((s) => s.name === name)
            ? undefined
            : `서버 없음: '${name}' (가능: ${names().join(', ')})`;
        },
      },
      {
        key: 'cwd',
        label: () => '경로 (Enter=홈, Tab=폴더)',
        placeholder: () => '~/project/foo (선택)',
        validate: (v) => (v && !SAFE_CWD.test(v) ? '경로 무효: 스페이스/특수문자는 미지원' : undefined),
        // A bare relative path is ambiguous: local `cd` runs from the dashboard's
        // cwd, remote from $HOME. Anchor it to ~/ so both agree (and it matches
        // what Tab-completion lists). Absolute / ~ / . paths are left as typed.
        transform: anchorHome,
        // Tab-complete directories on the chosen server (local or over SSH).
        // Anchor the input to ~/, split into "<base>/<partial>", list `base`,
        // keep sub-directories whose name starts with `partial`, and return the
        // full (anchored) paths so the caller can fill the longest common prefix.
        complete: async (value, draft) => {
          if (value && !SAFE_CWD.test(value)) return []; // never interpolate unsafe input
          const server = servers.find((s) => s.name === (draft.server || 'local'));
          if (!server) return [];
          const anchored = value === '' ? '~/' : anchorHome(value);
          const slash = anchored.lastIndexOf('/'); // always present after anchoring
          const base = anchored.slice(0, slash + 1); // e.g. '~/', '~/project/', '/'
          const partial = anchored.slice(slash + 1);
          const { stdout, code } = await exec(server, `ls -1Ap ${base} 2>/dev/null`);
          if (code !== 0) return [];
          const wantHidden = partial.startsWith('.'); // reveal dotdirs only when asked for
          return stdout
            .split('\n')
            .filter((l) => l.endsWith('/')) // -p marks directories with a trailing slash
            .map((l) => l.slice(0, -1))
            .filter((name) => name && (wantHidden || !name.startsWith('.')))
            .filter((name) => name.startsWith(partial))
            .sort()
            .slice(0, 200)
            .map((name) => `${base}${name}/`);
        },
      },
      {
        key: 'name',
        label: () => `세션 이름 (Enter=${defaultSessionName()})`,
        placeholder: () => defaultSessionName(),
      },
    ],
    onComplete: async (draft, ctx) => {
      const server = servers.find((s) => s.name === draft.server);
      if (!server) return '서버를 찾지 못함';
      ctx.flash('launching...');
      const r = await newSessionInCmux(server, draft.name, draft.cwd ?? '');
      return r.message;
    },
  };
}
