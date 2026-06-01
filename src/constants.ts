// Centralized tunables. Polling cadences and layout dimensions previously lived
// as scattered magic numbers in App.tsx; collecting them here keeps the values
// in one place and lets hooks/components share them. Values are unchanged.

// Background refresh intervals (ms): liveness/status fast, full list slower.
export const POLLING_INTERVALS = {
  liveness: 3000,
  sessions: 15000,
  transcript: 3000,
  rateLimits: 60_000,
} as const;

// Layout dimensions (terminal columns / rows). See App.tsx layout math.
export const UI = {
  sidebarWidth: 20, // ServerList / Filter column
  sessionListWidth: 40, // SessionList column
  rightColumnReserve: 64, // columns reserved for the two left columns + gaps
  rightColumnMinWidth: 40, // floor for the transcript column width
  paneHeightMargin: 3, // usage header (1) + footer (1) + margin (1)
  sessionInfoHeight: 6, // border (2) + 4 content lines
  maxComposerLines: 6, // composer caps its growth here
  composerGutterReserve: 6, // transcriptWidth - 6 = composer input width
  transcriptBorderPad: 4, // borders (2) + paddingX (2)
} as const;
