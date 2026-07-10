/**
 * Owner-side rollups for renderer hot-path UI perf markers.
 *
 * Raw payload persistence stays in the existing `ui-perf` activity-log path;
 * these counters only make `query ui-perf` useful for quick triage.
 */

export type RendererHotPathUiPerfCounters = {
  planningChatInputReports: number;
  planningChatRenderReports: number;
  maxPlanningChatInputChars: number;
  maxPlanningChatInputDeltaChars: number;
  maxPlanningChatRenderMs: number;
  maxPlanningChatTranscriptLines: number;
  maxPlanningChatTranscriptChars: number;
  terminalXtermAttachReports: number;
  terminalXtermSnapshotSeedReports: number;
  terminalXtermOutputWriteReports: number;
  terminalXtermFitReports: number;
  terminalXtermInputReports: number;
  maxTerminalXtermAttachMs: number;
  maxTerminalXtermSnapshotSeedMs: number;
  maxTerminalXtermSnapshotSeedBytes: number;
  maxTerminalXtermOutputWriteMs: number;
  maxTerminalXtermOutputBurstChunks: number;
  maxTerminalXtermOutputBurstBytes: number;
  maxTerminalXtermFitMs: number;
  maxTerminalXtermInputBytes: number;
};

export function createRendererHotPathUiPerfCounters(): RendererHotPathUiPerfCounters {
  return {
    planningChatInputReports: 0,
    planningChatRenderReports: 0,
    maxPlanningChatInputChars: 0,
    maxPlanningChatInputDeltaChars: 0,
    maxPlanningChatRenderMs: 0,
    maxPlanningChatTranscriptLines: 0,
    maxPlanningChatTranscriptChars: 0,
    terminalXtermAttachReports: 0,
    terminalXtermSnapshotSeedReports: 0,
    terminalXtermOutputWriteReports: 0,
    terminalXtermFitReports: 0,
    terminalXtermInputReports: 0,
    maxTerminalXtermAttachMs: 0,
    maxTerminalXtermSnapshotSeedMs: 0,
    maxTerminalXtermSnapshotSeedBytes: 0,
    maxTerminalXtermOutputWriteMs: 0,
    maxTerminalXtermOutputBurstChunks: 0,
    maxTerminalXtermOutputBurstBytes: 0,
    maxTerminalXtermFitMs: 0,
    maxTerminalXtermInputBytes: 0,
  };
}

export function resetRendererHotPathUiPerfCounters(counters: RendererHotPathUiPerfCounters): void {
  Object.assign(counters, createRendererHotPathUiPerfCounters());
}

function numberValue(data: Record<string, unknown> | undefined, key: string): number | null {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maxCounter(
  counters: RendererHotPathUiPerfCounters,
  key: keyof RendererHotPathUiPerfCounters,
  value: number | null,
): void {
  if (value === null) return;
  counters[key] = Math.max(counters[key], value);
}

export function recordRendererHotPathUiPerfMetric(
  counters: RendererHotPathUiPerfCounters,
  metric: string,
  data?: Record<string, unknown>,
): void {
  if (metric === 'planning_chat_input_change') {
    counters.planningChatInputReports += 1;
    maxCounter(counters, 'maxPlanningChatInputChars', numberValue(data, 'inputChars'));
    const deltaChars = numberValue(data, 'deltaChars');
    maxCounter(counters, 'maxPlanningChatInputDeltaChars', deltaChars === null ? null : Math.abs(deltaChars));
    return;
  }

  if (metric === 'planning_chat_render') {
    counters.planningChatRenderReports += 1;
    maxCounter(counters, 'maxPlanningChatRenderMs', numberValue(data, 'durationMs'));
    maxCounter(counters, 'maxPlanningChatTranscriptLines', numberValue(data, 'transcriptLines'));
    maxCounter(counters, 'maxPlanningChatTranscriptChars', numberValue(data, 'transcriptChars'));
    return;
  }

  if (metric === 'terminal_xterm_attach') {
    counters.terminalXtermAttachReports += 1;
    maxCounter(counters, 'maxTerminalXtermAttachMs', numberValue(data, 'durationMs'));
    return;
  }

  if (metric === 'terminal_xterm_snapshot_seed') {
    counters.terminalXtermSnapshotSeedReports += 1;
    maxCounter(counters, 'maxTerminalXtermSnapshotSeedMs', numberValue(data, 'durationMs'));
    maxCounter(counters, 'maxTerminalXtermSnapshotSeedBytes', numberValue(data, 'bytes'));
    return;
  }

  if (metric === 'terminal_xterm_output_write') {
    counters.terminalXtermOutputWriteReports += 1;
    maxCounter(counters, 'maxTerminalXtermOutputWriteMs', numberValue(data, 'durationMs'));
    maxCounter(counters, 'maxTerminalXtermOutputBurstChunks', numberValue(data, 'chunksInWindow'));
    maxCounter(counters, 'maxTerminalXtermOutputBurstBytes', numberValue(data, 'bytesInWindow'));
    return;
  }

  if (metric === 'terminal_xterm_fit') {
    counters.terminalXtermFitReports += 1;
    maxCounter(counters, 'maxTerminalXtermFitMs', numberValue(data, 'durationMs'));
    return;
  }

  if (metric === 'terminal_xterm_input') {
    counters.terminalXtermInputReports += 1;
    maxCounter(counters, 'maxTerminalXtermInputBytes', numberValue(data, 'bytes'));
  }
}
