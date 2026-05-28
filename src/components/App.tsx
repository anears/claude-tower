import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { ServerList, type FilterItem } from './ServerList.js';
import { SessionList } from './SessionList.js';
import { Transcript } from './Transcript.js';
import { SessionInfoPanel } from './SessionInfo.js';
import { Composer } from './Composer.js';
import { UsageBar } from './UsageBar.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TextInput from 'ink-text-input';
import type { Config, ServerConfig } from '../config.js';
import { saveConfig } from '../config.js';
import type { SessionInfo, TranscriptEntry } from '../types/message.js';
import { listSessions, readTranscript } from '../lib/sessions.js';
import { getLiveness, type Liveness } from '../lib/liveness.js';
import { sendToSession } from '../lib/tmux.js';
import { openSessionInCmux, newSessionInCmux, defaultSessionName } from '../lib/cmux.js';
import { disconnectAll } from '../lib/ssh.js';
import { countLines } from '../lib/wrap.js';
import { computeSessionUsage, getRateLimits, type RateLimits } from '../lib/usage.js';
import { usePolling } from '../hooks/usePolling.js';

type Pane = 'filter' | 'sessions' | 'transcript';

const LIVENESS_INTERVAL = 3000;
const SESSIONS_INTERVAL = 15000;
const TRANSCRIPT_INTERVAL = 3000;
const RATE_LIMITS_INTERVAL = 60_000;

interface Props {
  config: Config;
}

type ConfigMode =
  | { kind: 'add'; step: number; draft: Partial<ServerConfig>; value: string }
  | { kind: 'delete'; serverName: string }
  | { kind: 'newSession'; step: number; draft: { server?: string; name?: string }; value: string }
  | null;

const ADD_STEPS: Array<keyof ServerConfig> = ['name', 'host', 'username', 'privateKeyPath'];
const ADD_LABELS: Record<string, string> = {
  name: '이름 (예: f7)',
  host: '호스트 (IP 또는 SSH alias)',
  username: '사용자명',
  privateKeyPath: '개인키 경로 (Enter면 기본값)',
};

export function App({ config: initialConfig }: Props) {
  const [config, setConfig] = useState<Config>(initialConfig);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [pane, setPane] = useState<Pane>('sessions');
  const [filterIdx, setFilterIdx] = useState(1); // 0 = Live toggle, 1 = All (default)
  const [liveOnly, setLiveOnly] = useState(false);
  const [sessionIdx, setSessionIdx] = useState(0);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [liveness, setLiveness] = useState<Map<string, Liveness>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | undefined>();
  const [inputMode, setInputMode] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [flash, setFlash] = useState<string | undefined>();
  const [transcriptScroll, setTranscriptScroll] = useState(0);
  const transcriptScrollRef = useRef(0);
  transcriptScrollRef.current = transcriptScroll;
  const [rateLimits, setRateLimits] = useState<RateLimits | undefined>();
  const [configMode, setConfigMode] = useState<ConfigMode>(null);

  // Cluster-wide list comes from one server (NFS-shared home); liveness is
  // gathered from every server.
  const primary: ServerConfig | undefined = config.servers[0];

  const allSessionsRef = useRef<SessionInfo[]>([]);
  allSessionsRef.current = allSessions;

  // Fetch from every configured server in parallel and dedupe by sessionId.
  // Cluster servers sharing NFS will return identical entries — the first one
  // wins (its `source` field marks where transcript reads will go). Local
  // sessions are kept distinct since they live on a different filesystem.
  const loadSessions = async (cfg: Config = config): Promise<SessionInfo[]> => {
    if (cfg.servers.length === 0) return [];
    const results = await Promise.all(
      cfg.servers.map(async (s) => {
        try {
          return await listSessions(s);
        } catch {
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    const merged: SessionInfo[] = [];
    for (const list of results) {
      for (const s of list) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        merged.push(s);
      }
    }
    merged.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    setAllSessions(merged);
    return merged;
  };

  // Lookup a server by name (for transcript reads that target the session's source).
  const serverByName = useMemo(() => {
    const m = new Map<string, ServerConfig>();
    for (const s of config.servers) m.set(s.name, s);
    return m;
  }, [config.servers]);
  const loadLiveness = async (sessionsForMatch: SessionInfo[], cfg: Config = config) => {
    setLiveness(await getLiveness(cfg.servers, sessionsForMatch));
  };

  // Initial load — sessions first so liveness can map unregistered processes by cwd.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSessions();
        if (!cancelled) await Promise.all([loadLiveness(s), loadRateLimits()]);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRateLimits = async () => {
    const r = await getRateLimits();
    if (r) setRateLimits(r);
  };

  // Background refresh: liveness/status fast, full list slower.
  usePolling(() => loadLiveness(allSessionsRef.current), LIVENESS_INTERVAL);
  usePolling(async () => {
    await loadSessions();
  }, SESSIONS_INTERVAL);
  usePolling(loadRateLimits, RATE_LIMITS_INTERVAL);

  // Enrich + filter for display.
  const sessions: SessionInfo[] = useMemo(() => {
    let enriched = allSessions.map((s) => {
      const lv = liveness.get(s.sessionId);
      return { ...s, liveOn: lv?.liveOn ?? [], status: lv?.status, tmuxTarget: lv?.tmuxTarget };
    });
    if (liveOnly) enriched = enriched.filter((s) => s.liveOn.length > 0);
    // filterIdx 0 = toggle row (no server filter applied here), 1 = All, 2+ = server
    if (filterIdx <= 1) return enriched;
    const serverName = config.servers[filterIdx - 2]?.name;
    if (!serverName) return enriched;
    return enriched.filter((s) => s.liveOn.includes(serverName));
  }, [allSessions, liveness, liveOnly, filterIdx, config.servers]);

  const filterItems: FilterItem[] = useMemo(() => {
    const liveCounts = new Map<string, number>();
    let totalLive = 0;
    for (const lv of liveness.values()) {
      if (lv.liveOn.length > 0) totalLive += 1;
      for (const server of lv.liveOn) liveCounts.set(server, (liveCounts.get(server) ?? 0) + 1);
    }
    return [
      { label: 'Live', hint: `(▶${totalLive})`, checked: liveOnly },
      { label: 'All', hint: `(${allSessions.length})` },
      ...config.servers.map((s) => ({ label: s.name, hint: `(▶${liveCounts.get(s.name) ?? 0})` })),
    ];
  }, [liveness, liveOnly, allSessions.length, config.servers]);

  const currentSession: SessionInfo | undefined = sessions[sessionIdx];
  const currentSessionRef = useRef(currentSession);
  currentSessionRef.current = currentSession;

  const transcriptMeta = useMemo(() => {
    let turns = 0;
    let outTokens = 0;
    for (const e of transcript) {
      if (e.type === 'user') {
        const c = e.message.content;
        const hasText = typeof c === 'string' ? c.trim().length > 0 : c.some((b) => b.type === 'text');
        if (hasText) turns++;
      } else if (e.type === 'assistant') {
        outTokens += e.message.usage?.output_tokens ?? 0;
      }
    }
    return {
      title: currentSession?.aiTitle,
      gitBranch: currentSession?.gitBranch,
      turns,
      outTokens,
      usage: computeSessionUsage(transcript),
    };
  }, [transcript, currentSession?.aiTitle, currentSession?.gitBranch]);

  // Clamp selection when the filtered list shrinks.
  useEffect(() => {
    if (sessionIdx > sessions.length - 1) setSessionIdx(Math.max(0, sessions.length - 1));
  }, [sessions.length]);

  // Fetch transcript immediately when the selected session changes.
  useEffect(() => {
    const sourceServer = currentSession ? serverByName.get(currentSession.source) : undefined;
    if (!sourceServer || !currentSession) {
      setTranscript([]);
      return;
    }
    let cancelled = false;
    const filePath = currentSession.filePath;
    setTranscriptScroll(0); // new session → back to tailing latest
    setTranscriptLoading(true);
    setTranscriptError(undefined);
    readTranscript(sourceServer, filePath)
      .then((t) => {
        if (!cancelled && currentSessionRef.current?.filePath === filePath) {
          setTranscript(t);
          setTranscriptLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTranscriptError((err as Error).message ?? String(err));
          setTranscriptLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentSession?.filePath]);

  // Background refresh of the transcript — only while the selected session is
  // live (idle/offline transcripts don't change), and without a loading flag so
  // the view tails new output without flicker.
  usePolling(async () => {
    const s = currentSessionRef.current;
    if (!s || s.liveOn.length === 0) return;
    if (transcriptScrollRef.current > 0) return; // user is reading old content
    const sourceServer = serverByName.get(s.source);
    if (!sourceServer) return;
    const filePath = s.filePath;
    const t = await readTranscript(sourceServer, filePath);
    if (currentSessionRef.current?.filePath === filePath && transcriptScrollRef.current === 0) {
      setTranscript(t);
    }
  }, TRANSCRIPT_INTERVAL);

  // ---- Server add / delete -------------------------------------------------
  const startAddServer = () => {
    setFlash(undefined);
    setConfigMode({ kind: 'add', step: 0, draft: {}, value: '' });
  };

  const advanceAddServer = async (val: string) => {
    if (configMode?.kind !== 'add') return;
    const key = ADD_STEPS[configMode.step];
    const v = val.trim();
    const draft = { ...configMode.draft, [key]: v };
    const nextStep = configMode.step + 1;
    if (nextStep < ADD_STEPS.length) {
      setConfigMode({ kind: 'add', step: nextStep, draft, value: '' });
      return;
    }
    // Build the new server
    const newServer: ServerConfig = {
      name: (draft.name as string) || '',
      host: (draft.host as string) || '',
      port: 22,
      username: (draft.username as string) || '',
      privateKeyPath: (draft.privateKeyPath as string) || join(homedir(), '.ssh', 'id_ed25519'),
      remoteClaudeDir: '~/.claude',
      local: false,
    };
    if (!newServer.name || !newServer.host || !newServer.username) {
      setFlash('필수값 누락 (이름/호스트/사용자명)');
      setConfigMode(null);
      return;
    }
    if (config.servers.some((s) => s.name === newServer.name)) {
      setFlash(`'${newServer.name}' 은 이미 존재함`);
      setConfigMode(null);
      return;
    }
    const newCfg: Config = { servers: [...config.servers, newServer] };
    try {
      await saveConfig(newCfg);
    } catch (e) {
      setFlash(`저장 실패: ${(e as Error).message}`);
      setConfigMode(null);
      return;
    }
    setConfig(newCfg);
    setConfigMode(null);
    setFlash(`✓ 추가됨: ${newServer.name}`);
    void loadSessions(newCfg).then((s) => loadLiveness(s, newCfg));
  };

  const startDeleteServer = () => {
    const item = filterItems[filterIdx];
    if (!item || item.checked !== undefined || item.label === 'All') {
      setFlash('이 항목은 삭제할 수 없음');
      return;
    }
    const srv = config.servers.find((s) => s.name === item.label);
    if (!srv) return;
    if (srv.local) {
      setFlash('로컬 서버는 삭제할 수 없음');
      return;
    }
    setConfigMode({ kind: 'delete', serverName: srv.name });
  };

  const confirmDeleteServer = async () => {
    if (configMode?.kind !== 'delete') return;
    const newCfg: Config = { servers: config.servers.filter((s) => s.name !== configMode.serverName) };
    try {
      await saveConfig(newCfg);
    } catch (e) {
      setFlash(`삭제 저장 실패: ${(e as Error).message}`);
      setConfigMode(null);
      return;
    }
    const removed = configMode.serverName;
    setConfig(newCfg);
    setConfigMode(null);
    setFilterIdx((i) => Math.max(0, Math.min(i, newCfg.servers.length /* incl Live toggle + All */)));
    setFlash(`✓ 삭제됨: ${removed}`);
    void loadSessions(newCfg).then((s) => loadLiveness(s, newCfg));
  };

  const tryOpenInCmux = () => {
    const s = currentSessionRef.current;
    if (!s) return;
    setFlash('opening in cmux...');
    void openSessionInCmux(s).then((r) => setFlash(r.message));
  };

  // ---- Launch new session in tmux ------------------------------------------
  const startNewSession = () => {
    setFlash(undefined);
    setConfigMode({ kind: 'newSession', step: 0, draft: {}, value: '' });
  };

  const advanceNewSession = async (val: string) => {
    if (configMode?.kind !== 'newSession') return;
    const v = val.trim();
    if (configMode.step === 0) {
      const serverName = v || 'local';
      const server = config.servers.find((s) => s.name === serverName);
      if (!server) {
        setFlash(`서버 없음: '${serverName}' (가능: ${config.servers.map((s) => s.name).join(', ')})`);
        setConfigMode(null);
        return;
      }
      setConfigMode({
        kind: 'newSession',
        step: 1,
        draft: { server: serverName },
        value: '',
      });
      return;
    }
    // step 1: session name (empty → default)
    const server = config.servers.find((s) => s.name === configMode.draft.server);
    if (!server) {
      setFlash('서버를 찾지 못함');
      setConfigMode(null);
      return;
    }
    setConfigMode(null);
    setFlash('launching...');
    const r = await newSessionInCmux(server, v);
    setFlash(r.message);
  };

  const tryEnterInput = () => {
    const s = currentSessionRef.current;
    if (!s) return;
    if (!s.tmuxTarget) {
      setFlash('이 세션은 입력 불가 (오프라인 또는 tmux 밖)');
      return;
    }
    if (s.status === 'busy') {
      setFlash('세션이 busy — 끝난 뒤 다시 시도');
      return;
    }
    setFlash(undefined);
    setInputValue('');
    setInputMode(true);
  };

  const handleSubmitInput = async (val: string) => {
    const text = val.trim();
    setInputValue('');
    const s = currentSessionRef.current;
    if (!text) return; // stay in input mode for the next message
    if (!s?.tmuxTarget) {
      setFlash('입력 불가 (오프라인 또는 tmux 밖)');
      return;
    }
    const target = s.tmuxTarget;
    // Optimistic echo — show the sent message immediately, like a chat app.
    setTranscript((prev) => [...prev, { type: 'user', message: { role: 'user', content: text } }]);
    try {
      await sendToSession(config.servers, target, text);
      setFlash(`✓ → ${target}`);
      void loadLiveness(allSessionsRef.current); // reflect busy quickly
    } catch (err) {
      setFlash(`✗ 전송 실패: ${(err as Error).message}`);
    }
    // Keep input mode active so the user can keep chatting (Esc to exit).
  };

  // Navigation — disabled while typing in the input box.
  useInput(
    (input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        disconnectAll().finally(() => exit());
        return;
      }
      if (input === 'r') {
        void (async () => {
          const s = await loadSessions();
          await loadLiveness(s);
        })();
        return;
      }
      if (key.tab) {
        setPane((p) => (p === 'filter' ? 'sessions' : p === 'sessions' ? 'transcript' : 'filter'));
        return;
      }
      if (pane === 'filter') {
        const item = filterItems[filterIdx];
        const isToggle = item?.checked !== undefined;
        if (key.upArrow) setFilterIdx((i) => Math.max(0, i - 1));
        if (key.downArrow) setFilterIdx((i) => Math.min(filterItems.length - 1, i + 1));
        if (input === ' ' || (key.return && isToggle)) {
          if (isToggle) setLiveOnly((v) => !v);
          return;
        }
        if (input === 'a') {
          startAddServer();
          return;
        }
        if (input === 'd') {
          startDeleteServer();
          return;
        }
        if (input === 'n') {
          startNewSession();
          return;
        }
        if (key.rightArrow || key.return) setPane('sessions');
      } else if (pane === 'sessions') {
        if (key.upArrow) setSessionIdx((i) => Math.max(0, i - 1));
        if (key.downArrow) setSessionIdx((i) => Math.min(sessions.length - 1, i + 1));
        if (key.leftArrow) setPane('filter');
        if (key.rightArrow) setPane('transcript');
        if (input === 'i' || key.return) tryEnterInput();
        if (input === 'o') tryOpenInCmux();
        if (input === 'n') startNewSession();
      } else {
        // transcript pane — scroll the chat view
        const ARROW_STEP = 3;
        const page = Math.max(1, (stdout?.rows ?? 30) - 4);
        if (key.upArrow) setTranscriptScroll((n) => n + ARROW_STEP);
        if (key.downArrow) setTranscriptScroll((n) => Math.max(0, n - ARROW_STEP));
        if (key.pageUp) setTranscriptScroll((n) => n + page);
        if (key.pageDown) setTranscriptScroll((n) => Math.max(0, n - page));
        if (input === 'g') setTranscriptScroll(1_000_000); // clamped to top in Transcript
        if (input === 'G') {
          setTranscriptScroll(0);
          // Force refresh immediately since polling was paused while scrolled.
          const s = currentSessionRef.current;
          const sourceServer = s ? serverByName.get(s.source) : undefined;
          if (sourceServer && s) {
            void readTranscript(sourceServer, s.filePath).then((t) => {
              if (currentSessionRef.current?.filePath === s.filePath) setTranscript(t);
            });
          }
        }
        if (key.leftArrow) setPane('sessions');
        if (input === 'i' || key.return) tryEnterInput();
        if (input === 'o') tryOpenInCmux();
      }
    },
    { isActive: !inputMode && !configMode },
  );

  // Escape cancels input mode.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setInputMode(false);
        setInputValue('');
      }
    },
    { isActive: inputMode },
  );

  // Configuration mode: Esc cancels; for delete, y/n confirms.
  useInput(
    (input, key) => {
      if (key.escape) {
        setConfigMode(null);
        return;
      }
      if (configMode?.kind === 'delete') {
        if (input === 'y' || input === 'Y') void confirmDeleteServer();
        if (input === 'n' || input === 'N') setConfigMode(null);
      }
    },
    { isActive: !!configMode },
  );

  const totalWidth = stdout?.columns ?? 120;
  const totalHeight = stdout?.rows ?? 30;
  const transcriptWidth = Math.max(40, totalWidth - 64);
  const paneHeight = totalHeight - 3; // usage header (1) + footer (1) + margin (1)
  // The right column stacks: SessionInfo / Transcript / Composer.
  // SessionInfo is fixed height; composer grows with input; transcript absorbs the rest.
  const MAX_COMPOSER_LINES = 6;
  const composerInputWidth = Math.max(4, transcriptWidth - 6);
  const composerTextLines = inputMode
    ? Math.min(MAX_COMPOSER_LINES, countLines(inputValue, composerInputWidth))
    : 1;
  const composerHeight = composerTextLines + 2; // round border (2) + text lines
  const sessionInfoHeight = 6; // border (2) + 4 content lines (title + cwd + status + ctx)
  const transcriptHeight = Math.max(3, paneHeight - composerHeight - sessionInfoHeight);

  const composerDisabledReason = !currentSession
    ? '세션을 선택하세요'
    : !currentSession.tmuxTarget
      ? currentSession.liveOn.length === 0
        ? '오프라인 세션 — 입력 불가'
        : 'tmux 밖에서 실행 중 — 입력 불가'
      : undefined;

  if (loading) {
    return (
      <Box padding={1}>
        <Text>Loading sessions from {primary?.name ?? '(no server)'}…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <UsageBar limits={rateLimits} />
      <Box>
        <ServerList
          items={filterItems}
          selectedIndex={filterIdx}
          focused={pane === 'filter'}
          height={paneHeight}
        />
        <SessionList
          sessions={sessions}
          selectedIndex={sessionIdx}
          focused={pane === 'sessions'}
          loading={false}
          error={loadError}
          height={paneHeight}
        />
        <Box flexDirection="column" width={transcriptWidth} height={paneHeight} overflow="hidden">
          <SessionInfoPanel
            width={transcriptWidth}
            height={sessionInfoHeight}
            session={currentSession}
            usage={transcriptMeta.usage}
            turns={transcriptMeta.turns}
            entries={transcript.length}
          />
          <Transcript
            entries={transcript}
            loading={transcriptLoading}
            error={transcriptError}
            width={transcriptWidth}
            height={transcriptHeight}
            focused={pane === 'transcript'}
            scrollOffset={transcriptScroll}
            onClamp={setTranscriptScroll}
          />
          <Composer
            width={transcriptWidth}
            textLines={composerTextLines}
            focused={inputMode}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmitInput}
            target={currentSession?.tmuxTarget}
            disabledReason={composerDisabledReason}
            status={currentSession?.status}
          />
        </Box>
      </Box>
      <Box paddingX={1}>
        {configMode?.kind === 'add' ? (
          <Box>
            <Text color="cyan">
              Add 서버 ({configMode.step + 1}/{ADD_STEPS.length}){' '}
              {ADD_LABELS[ADD_STEPS[configMode.step]!]}:{' '}
            </Text>
            <TextInput
              value={configMode.value}
              onChange={(v) =>
                setConfigMode((m) => (m?.kind === 'add' ? { ...m, value: v } : m))
              }
              onSubmit={advanceAddServer}
              focus
              placeholder={ADD_STEPS[configMode.step] === 'privateKeyPath' ? '~/.ssh/id_ed25519' : ''}
            />
          </Box>
        ) : configMode?.kind === 'delete' ? (
          <Text>
            <Text color="red">Delete </Text>
            <Text bold>{configMode.serverName}</Text>
            <Text color="red">? [y/n]</Text>
          </Text>
        ) : configMode?.kind === 'newSession' ? (
          <Box>
            <Text color="cyan">
              New session ({configMode.step + 1}/2){' '}
              {configMode.step === 0
                ? `서버 (${config.servers.map((s) => s.name).join('|')}, Enter=local)`
                : `세션 이름 (Enter=${defaultSessionName()})`}
              :{' '}
            </Text>
            <TextInput
              value={configMode.value}
              onChange={(v) =>
                setConfigMode((m) => (m?.kind === 'newSession' ? { ...m, value: v } : m))
              }
              onSubmit={advanceNewSession}
              focus
              placeholder={configMode.step === 0 ? 'local' : defaultSessionName()}
            />
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            {inputMode ? (
              <Text color="cyan">채팅 모드 · Enter 전송 · Esc 나가기</Text>
            ) : pane === 'transcript' ? (
              <>
                [Tab] pane · [↑↓] 3줄 · [PgUp/PgDn] 페이지 · [g/G] 처음/최신 · [←] 뒤로 · [i] 채팅 · [o] cmux · [q]
              </>
            ) : pane === 'filter' ? (
              <>
                [Tab] pane · [↑↓] nav · [Space] toggle · [a] 추가 · [d] 삭제 · [n] 새 세션 · [r] refresh ·{' '}
                <Text color="yellow">●</Text>busy <Text color="green">●</Text>idle ○off · [q] quit
              </>
            ) : (
              <>
                [Tab] pane · [↑↓] nav · [i] 채팅 · [o] cmux · [n] 새 세션 · [r] refresh ·{' '}
                <Text color="yellow">●</Text>busy <Text color="green">●</Text>idle ○off · [q] quit
              </>
            )}
            {flash ? <Text color="yellow"> · {flash}</Text> : null}
          </Text>
        )}
      </Box>
    </Box>
  );
}
