import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { ServerList, type FilterItem } from './ServerList.js';
import { SessionList } from './SessionList.js';
import { Transcript } from './Transcript.js';
import { SessionInfoPanel } from './SessionInfo.js';
import { Composer } from './Composer.js';
import { UsageBar } from './UsageBar.js';
import { FlowPrompt } from './FlowPrompt.js';
import { DailyReport } from './DailyReport.js';
import type { Config, ServerConfig } from '../config.js';
import type { SessionInfo } from '../types/message.js';
import { sendToSession } from '../lib/tmux.js';
import { openSessionInCmux } from '../lib/cmux.js';
import { disconnectAll } from '../lib/ssh.js';
import { countLines } from '../lib/wrap.js';
import { computeSessionUsage } from '../lib/usage.js';
import { computeTranscriptStats } from '../lib/transcript-stats.js';
import { UI } from '../constants.js';
import { useSessions } from '../hooks/useSessions.js';
import { useLiveness } from '../hooks/useLiveness.js';
import { useRateLimits } from '../hooks/useRateLimits.js';
import { useTranscript } from '../hooks/useTranscript.js';
import { useFlow } from '../hooks/useFlow.js';
import { useDailyReport } from '../hooks/useDailyReport.js';
import { addServerFlow, deleteServerFlow } from '../lib/flows/serverFlows.js';
import { newSessionFlow } from '../lib/flows/sessionFlows.js';
import { saveReportLocally, polishReport } from '../lib/report-io.js';
import { localDateLabel } from '../lib/daily-report.js';

type Pane = 'filter' | 'sessions' | 'transcript';

interface Props {
  config: Config;
}

export function App({ config: initialConfig }: Props) {
  const [config, setConfig] = useState<Config>(initialConfig);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [pane, setPane] = useState<Pane>('sessions');
  const [filterIdx, setFilterIdx] = useState(1); // 0 = Live toggle, 1 = All (default)
  const [liveOnly, setLiveOnly] = useState(true);
  const [sessionIdx, setSessionIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [inputMode, setInputMode] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [flash, setFlash] = useState<string | undefined>();

  // Cluster-wide list comes from one server (NFS-shared home); liveness is
  // gathered from every server. Each concern owns its own polling + refs.
  const sessions_h = useSessions(config);
  const allSessions = sessions_h.allSessions;
  const liveness_h = useLiveness(config, allSessions);
  const liveness = liveness_h.liveness;
  const rate = useRateLimits();

  const primary: ServerConfig | undefined = config.servers[0];

  // Lookup a server by name (for transcript reads that target the session's source).
  const serverByName = useMemo(() => {
    const m = new Map<string, ServerConfig>();
    for (const s of config.servers) m.set(s.name, s);
    return m;
  }, [config.servers]);

  // Daily work report overlay (its own polling-free state machine).
  const report = useDailyReport(allSessions, serverByName);

  // Refresh sessions then liveness for a (possibly new) config — fire-and-forget.
  const reloadAfterConfig = (cfg: Config): void => {
    void sessions_h.reload(cfg).then((s) => liveness_h.reload(s, cfg));
  };

  // Initial load — sessions first so liveness can map unregistered processes by
  // cwd; gate the loading screen on sessions + liveness + rate limits.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await sessions_h.reload();
        if (!cancelled) await Promise.all([liveness_h.reload(s), rate.reload()]);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const sourceServer = currentSession ? serverByName.get(currentSession.source) : undefined;
  const transcript = useTranscript(sourceServer, currentSession);

  const transcriptMeta = useMemo(() => {
    const { turns, outTokens } = computeTranscriptStats(transcript.entries);
    return {
      title: currentSession?.aiTitle,
      gitBranch: currentSession?.gitBranch,
      turns,
      outTokens,
      usage: computeSessionUsage(transcript.entries),
    };
  }, [transcript.entries, currentSession?.aiTitle, currentSession?.gitBranch]);

  // Clamp selection when the filtered list shrinks.
  useEffect(() => {
    if (sessionIdx > sessions.length - 1) setSessionIdx(Math.max(0, sessions.length - 1));
  }, [sessions.length]);

  // ---- Flows (add/delete server, new session) ------------------------------
  const flow = useFlow(setFlash);

  const startAddServer = () => {
    setFlash(undefined);
    flow.start(addServerFlow({ config, applyConfig: setConfig, reload: reloadAfterConfig }));
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
    flow.start(
      deleteServerFlow(srv.name, {
        config,
        applyConfig: setConfig,
        reload: reloadAfterConfig,
        afterDelete: (newCfg) =>
          setFilterIdx((i) => Math.max(0, Math.min(i, newCfg.servers.length /* incl Live toggle + All */))),
      }),
    );
  };

  const startNewSession = () => {
    setFlash(undefined);
    flow.start(newSessionFlow(config.servers));
  };

  const tryOpenInCmux = () => {
    const s = currentSessionRef.current;
    if (!s) return;
    setFlash(s.tmuxTarget ? 'opening in cmux...' : 'resuming offline session...');
    void openSessionInCmux(s, config.servers).then((r) => setFlash(r.message));
  };

  // Save the current report as markdown on this (dashboard) machine.
  const saveReport = () => {
    const r = report.report;
    if (!r) {
      setFlash('리포트가 아직 없음');
      return;
    }
    setFlash('저장 중…');
    void saveReportLocally(r)
      .then((path) => setFlash(`✓ 저장됨: ${path}`))
      .catch((err) => setFlash(`✗ 저장 실패: ${(err as Error).message}`));
  };

  // Launch a fresh cmux session that reads the saved report and rewrites it
  // (interactive claude — subscription, no metered API cost).
  const startPolish = () => {
    const r = report.report;
    if (!r) {
      setFlash('리포트가 아직 없음');
      return;
    }
    setFlash('윤문 세션 시작 중…');
    void polishReport(r)
      .then((m) => setFlash(m))
      .catch((err) => setFlash(`✗ ${(err as Error).message}`));
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
    transcript.appendOptimistic({ type: 'user', message: { role: 'user', content: text } });
    try {
      await sendToSession(config.servers, target, text);
      setFlash(`✓ → ${target}`);
      void liveness_h.reload(); // reflect busy quickly
    } catch (err) {
      setFlash(`✗ 전송 실패: ${(err as Error).message}`);
    }
    // Keep input mode active so the user can keep chatting (Esc to exit).
  };

  // Navigation — disabled while typing in the input box or running a flow.
  useInput(
    (input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        disconnectAll().finally(() => exit());
        return;
      }
      if (input === 'r') {
        void (async () => {
          const s = await sessions_h.reload();
          await liveness_h.reload(s);
        })();
        return;
      }
      if (input === 'D') {
        report.openReport();
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
        if (key.upArrow) transcript.setScrollOffset((n) => n + ARROW_STEP);
        if (key.downArrow) transcript.setScrollOffset((n) => Math.max(0, n - ARROW_STEP));
        if (key.pageUp) transcript.setScrollOffset((n) => n + page);
        if (key.pageDown) transcript.setScrollOffset((n) => Math.max(0, n - page));
        if (input === 'g') transcript.setScrollOffset(1_000_000); // clamped to top in Transcript
        if (input === 'G') transcript.forceTail();
        if (key.leftArrow) setPane('sessions');
        if (input === 'i' || key.return) tryEnterInput();
        if (input === 'o') tryOpenInCmux();
      }
    },
    { isActive: !inputMode && !flow.active && !report.open },
  );

  // Daily report overlay: scroll, day navigation, save, AI polish.
  useInput(
    (input, key) => {
      const page = Math.max(1, (stdout?.rows ?? 30) - 4);
      const ARROW_STEP = 3;
      if (key.escape || input === 'D') {
        report.close();
        return;
      }
      if (key.upArrow) report.setScrollOffset((n) => n + ARROW_STEP);
      if (key.downArrow) report.setScrollOffset((n) => Math.max(0, n - ARROW_STEP));
      if (key.pageUp) report.setScrollOffset((n) => n + page);
      if (key.pageDown) report.setScrollOffset((n) => Math.max(0, n - page));
      if (input === 'g') report.setScrollOffset(1_000_000); // clamped to top
      if (input === 'G') report.setScrollOffset(0);
      if (key.leftArrow || input === '[') report.shiftDay(-1);
      if (key.rightArrow || input === ']') report.shiftDay(1);
      if (input === 't') report.goToday();
      if (input === 's') saveReport();
      if (input === 'p') startPolish();
    },
    { isActive: report.open && !inputMode && !flow.active },
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

  // Flow mode: Esc cancels; Tab runs the current step's completion (if any);
  // for a confirm flow, y/n accepts/declines.
  useInput(
    (input, key) => {
      if (key.escape) {
        flow.cancel();
        return;
      }
      if (key.tab) {
        flow.tab();
        return;
      }
      if (flow.active?.def.confirm) {
        if (input === 'y' || input === 'Y') flow.confirm();
        if (input === 'n' || input === 'N') flow.cancel();
      }
    },
    { isActive: !!flow.active },
  );

  const totalWidth = stdout?.columns ?? 120;
  const totalHeight = stdout?.rows ?? 30;
  const transcriptWidth = Math.max(UI.rightColumnMinWidth, totalWidth - UI.rightColumnReserve);
  const paneHeight = totalHeight - UI.paneHeightMargin;
  // The right column stacks: SessionInfo / Transcript / Composer.
  // SessionInfo is fixed height; composer grows with input; transcript absorbs the rest.
  const composerInputWidth = Math.max(4, transcriptWidth - UI.composerGutterReserve);
  const composerTextLines = inputMode
    ? Math.min(UI.maxComposerLines, countLines(inputValue, composerInputWidth))
    : 1;
  const composerHeight = composerTextLines + 2; // round border (2) + text lines
  const sessionInfoHeight = UI.sessionInfoHeight;
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
      <UsageBar limits={rate.limits} />
      {report.open ? (
        <DailyReport
          report={report.report}
          loading={report.loading}
          error={report.error}
          dateLabel={localDateLabel(report.viewDate)}
          width={totalWidth}
          height={paneHeight}
          scrollOffset={report.scrollOffset}
          onClamp={report.setScrollOffset}
        />
      ) : (
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
            entries={transcript.entries.length}
          />
          <Transcript
            entries={transcript.entries}
            loading={transcript.loading}
            error={transcript.error}
            width={transcriptWidth}
            height={transcriptHeight}
            focused={pane === 'transcript'}
            scrollOffset={transcript.scrollOffset}
            onClamp={transcript.setScrollOffset}
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
      )}
      <Box paddingX={1}>
        {flow.active ? (
          <FlowPrompt active={flow.active} onChange={flow.setValue} onSubmit={flow.submit} />
        ) : (
          <Text dimColor wrap="truncate-end">
            {report.open ? (
              <Text color="magenta">
                일일 리포트 · [↑↓] 스크롤 · [←→] 날짜 · [t] 오늘 · [s] 저장 · [p] AI 윤문 · [Esc] 닫기
              </Text>
            ) : inputMode ? (
              <Text color="cyan">채팅 모드 · Enter 전송 · Esc 나가기</Text>
            ) : pane === 'transcript' ? (
              <>
                [Tab] pane · [↑↓] 3줄 · [PgUp/PgDn] 페이지 · [g/G] 처음/최신 · [←] 뒤로 · [i] 채팅 · [o] cmux · [D] 리포트 · [q]
              </>
            ) : pane === 'filter' ? (
              <>
                [Tab] pane · [↑↓] nav · [Space] toggle · [a] 추가 · [d] 삭제 · [n] 새 세션 · [D] 리포트 · [r] refresh ·{' '}
                <Text color="yellow">●</Text>busy <Text color="green">●</Text>idle ○off · [q] quit
              </>
            ) : (
              <>
                [Tab] pane · [↑↓] nav · [i] 채팅 · [o] cmux · [n] 새 세션 · [D] 리포트 · [r] refresh ·{' '}
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
