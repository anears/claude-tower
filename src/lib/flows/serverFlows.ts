import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, type Config, type ServerConfig } from '../../config.js';
import { checkConnection } from '../ssh.js';
import type { FlowDef } from '../../hooks/useFlow.js';

// Side effects the server flows perform on App state. `applyConfig` swaps the
// live config (setConfig); `reload` re-fetches sessions then liveness for the
// new config (fire-and-forget).
export interface ServerFlowDeps {
  config: Config;
  applyConfig: (cfg: Config) => void;
  reload: (cfg: Config) => void;
}

const ADD_LABELS = {
  name: '이름 (예: f7)',
  host: '호스트 (IP 또는 SSH alias)',
  username: '사용자명',
  privateKeyPath: '개인키 경로 (Enter=기본키, 에이전트 사용 시 비워도 됨)',
  passphrase: '키 암호 (없으면 Enter)',
} as const;

// Add a new (non-local) server: name → host → username → key path → passphrase,
// then verify the connection and save.
export function addServerFlow(deps: ServerFlowDeps): FlowDef {
  return {
    kind: 'addServer',
    header: 'Add 서버',
    steps: [
      { key: 'name', label: () => ADD_LABELS.name },
      { key: 'host', label: () => ADD_LABELS.host },
      { key: 'username', label: () => ADD_LABELS.username },
      { key: 'privateKeyPath', label: () => ADD_LABELS.privateKeyPath, placeholder: () => '~/.ssh/id_ed25519' },
      { key: 'passphrase', label: () => ADD_LABELS.passphrase, mask: '*' },
    ],
    onComplete: async (draft, ctx) => {
      const newServer: ServerConfig = {
        name: draft.name || '',
        host: draft.host || '',
        port: 22,
        username: draft.username || '',
        privateKeyPath: draft.privateKeyPath || join(homedir(), '.ssh', 'id_ed25519'),
        passphrase: draft.passphrase || undefined,
        remoteClaudeDir: '~/.claude',
        local: false,
      };
      if (!newServer.name || !newServer.host || !newServer.username) {
        return '필수값 누락 (이름/호스트/사용자명)';
      }
      if (deps.config.servers.some((s) => s.name === newServer.name)) {
        return `'${newServer.name}' 은 이미 존재함`;
      }
      // Verify the host is actually reachable before adding it to the list.
      ctx.flash(`연결 확인 중… (${newServer.username}@${newServer.host})`);
      const failure = await checkConnection(newServer);
      if (failure) return `✗ 연결 실패: ${failure}`;
      const newCfg: Config = { servers: [...deps.config.servers, newServer] };
      try {
        await saveConfig(newCfg);
      } catch (e) {
        return `저장 실패: ${(e as Error).message}`;
      }
      deps.applyConfig(newCfg);
      deps.reload(newCfg);
      return `✓ 추가됨: ${newServer.name}`;
    },
  };
}

// Confirm-and-delete a server. `afterDelete` clamps the filter selection to the
// shrunken server list (App's setFilterIdx).
export function deleteServerFlow(
  serverName: string,
  deps: ServerFlowDeps & { afterDelete: (cfg: Config) => void },
): FlowDef {
  return {
    kind: 'deleteServer',
    header: '',
    steps: [],
    confirm: { prefix: 'Delete ', subject: serverName, suffix: '? [y/n]', color: 'red' },
    onComplete: async () => {
      const newCfg: Config = { servers: deps.config.servers.filter((s) => s.name !== serverName) };
      try {
        await saveConfig(newCfg);
      } catch (e) {
        return `삭제 저장 실패: ${(e as Error).message}`;
      }
      deps.applyConfig(newCfg);
      deps.afterDelete(newCfg);
      deps.reload(newCfg);
      return `✓ 삭제됨: ${serverName}`;
    },
  };
}
