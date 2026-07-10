export type UiPerfHotPathCounters = {
  planningChatInputReports: number;
  planningChatRenderReports: number;
  maxPlanningChatInputMs: number;
  maxPlanningChatRenderMs: number;
  maxPlanningChatInputLength: number;
  maxPlanningChatLineCount: number;
  terminalXtermAttachReports: number;
  terminalXtermSnapshotSeedReports: number;
  terminalXtermOutputReports: number;
  terminalXtermInputReports: number;
  terminalXtermFitReports: number;
  maxTerminalXtermAttachMs: number;
  maxTerminalXtermSnapshotSeedMs: number;
  maxTerminalXtermOutputMs: number;
  maxTerminalXtermInputMs: number;
  maxTerminalXtermFitMs: number;
  maxTerminalXtermOutputBytes: number;
  maxTerminalXtermOutputBytesInWindow: number;
  maxTerminalXtermOutputChunksInWindow: number;
};

export function createUiPerfHotPathCounters(): UiPerfHotPathCounters {
  return {
    planningChatInputReports: 0,
    planningChatRenderReports: 0,
    maxPlanningChatInputMs: 0,
    maxPlanningChatRenderMs: 0,
    maxPlanningChatInputLength: 0,
    maxPlanningChatLineCount: 0,
    terminalXtermAttachReports: 0,
    terminalXtermSnapshotSeedReports: 0,
    terminalXtermOutputReports: 0,
    terminalXtermInputReports: 0,
    terminalXtermFitReports: 0,
    maxTerminalXtermAttachMs: 0,
    maxTerminalXtermSnapshotSeedMs: 0,
    maxTerminalXtermOutputMs: 0,
    maxTerminalXtermInputMs: 0,
    maxTerminalXtermFitMs: 0,
    maxTerminalXtermOutputBytes: 0,
    maxTerminalXtermOutputBytesInWindow: 0,
    maxTerminalXtermOutputChunksInWindow: 0,
  };
}

export function resetUiPerfHotPathCounters(counters: UiPerfHotPathCounters): void {
  const reset = createUiPerfHotPathCounters();
  for (const key of Object.keys(reset) as Array<keyof UiPerfHotPathCounters>) {
    counters[key] = reset[key];
  }
}

function numeric(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function recordMax(counters: UiPerfHotPathCounters, key: keyof UiPerfHotPathCounters, value: number): void {
  counters[key] = Math.max(counters[key], value);
}

export function recordUiPerfHotPathMetric(
  counters: UiPerfHotPathCounters,
  metric: string,
  data: Record<string, unknown>,
): void {
  const durationMs = numeric(data, 'durationMs');

  if (metric === 'planning_chat_input') {
    counters.planningChatInputReports += 1;
    recordMax(counters, 'maxPlanningChatInputMs', durationMs);
    recordMax(counters, 'maxPlanningChatInputLength', numeric(data, 'inputLength'));
    recordMax(counters, 'maxPlanningChatLineCount', numeric(data, 'lineCount'));
    return;
  }

  if (metric === 'planning_chat_render') {
    counters.planningChatRenderReports += 1;
    recordMax(counters, 'maxPlanningChatRenderMs', durationMs);
    recordMax(counters, 'maxPlanningChatInputLength', numeric(data, 'inputLength'));
    recordMax(counters, 'maxPlanningChatLineCount', numeric(data, 'lineCount'));
    return;
  }

  if (metric === 'terminal_xterm_attach') {
    counters.terminalXtermAttachReports += 1;
    recordMax(counters, 'maxTerminalXtermAttachMs', durationMs);
    return;
  }

  if (metric === 'terminal_xterm_snapshot_seed') {
    counters.terminalXtermSnapshotSeedReports += 1;
    recordMax(counters, 'maxTerminalXtermSnapshotSeedMs', durationMs);
    return;
  }

  if (metric === 'terminal_xterm_output') {
    counters.terminalXtermOutputReports += 1;
    recordMax(counters, 'maxTerminalXtermOutputMs', durationMs);
    recordMax(counters, 'maxTerminalXtermOutputBytes', numeric(data, 'bytes'));
    recordMax(counters, 'maxTerminalXtermOutputBytesInWindow', numeric(data, 'bytesInWindow'));
    recordMax(counters, 'maxTerminalXtermOutputChunksInWindow', numeric(data, 'chunksInWindow'));
    return;
  }

  if (metric === 'terminal_xterm_input') {
    counters.terminalXtermInputReports += 1;
    recordMax(counters, 'maxTerminalXtermInputMs', durationMs);
    return;
  }

  if (metric === 'terminal_xterm_fit') {
    counters.terminalXtermFitReports += 1;
    recordMax(counters, 'maxTerminalXtermFitMs', durationMs);
  }
}
