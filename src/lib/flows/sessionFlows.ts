import { newSessionInCmux, defaultSessionName } from '../cmux.js';
import type { ServerConfig } from '../../config.js';
import type { FlowDef } from '../../hooks/useFlow.js';

// Mirrors cmux.ts's SAFE_CWD: pre-validate the path so we can reject unsafe
// characters before handing off (cmux.ts re-validates too).
const SAFE_CWD = /^[\w./\-~]+$/;

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
        label: () => '경로 (Enter=홈)',
        placeholder: () => '~/project/foo (선택)',
        validate: (v) => (v && !SAFE_CWD.test(v) ? '경로 무효: 스페이스/특수문자는 미지원' : undefined),
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
