/**
 * Renderer-originated UI-perf counters.
 *
 * The main process owns persistence and IPC. This module only keeps the
 * aggregate counters behind getUiPerfStats/query ui-perf.
 */

export type RendererUiPerfCounters = {
  rendererReports: number;
  maxRendererEventLoopLagMs: number;
  maxRendererHiddenEventLoopLagMs: number;
  maxRendererCumulativeLagMs: number;
  maxRendererTickDeltaMs: number;
  maxRendererLongTaskMs: number;
  planningTypingLagReports: number;
  maxPlanningTypingLagMs: number;
  planningChatInputChangeReports: number;
  maxPlanningChatInputHandlerMs: number;
  planningChatInputCommitReports: number;
  maxPlanningChatInputCommitMs: number;
  planningChatTranscriptCommitReports: number;
  maxPlanningChatTranscriptCommitMs: number;
  maxPlanningChatTranscriptLines: number;
  maxPlanningChatTranscriptChars: number;
  planningChatTranscriptAutoscrollReports: number;
  maxPlanningChatTranscriptAutoscrollMs: number;
  planningChatSubmits: number;
  embeddedTerminalAttachReports: number;
  maxEmbeddedTerminalAttachMs: number;
  embeddedTerminalOpenRequestReports: number;
  maxEmbeddedTerminalOpenRequestMs: number;
  embeddedTerminalOpenExistingReports: number;
  maxEmbeddedTerminalOpenExistingMs: number;
  embeddedTerminalTabSelectReports: number;
  maxEmbeddedTerminalTabSelectMs: number;
  embeddedTerminalDrawerCycleReports: number;
  maxEmbeddedTerminalDrawerCycleMs: number;
  embeddedTerminalCloseReports: number;
  maxEmbeddedTerminalCloseMs: number;
  embeddedTerminalInputReports: number;
  maxEmbeddedTerminalInputMs: number;
  maxEmbeddedTerminalInputBytes: number;
  embeddedTerminalOutputWriteReports: number;
  maxEmbeddedTerminalOutputWriteMs: number;
  maxEmbeddedTerminalOutputWriteBytes: number;
  embeddedTerminalResizeReports: number;
  maxEmbeddedTerminalResizeMs: number;
  embeddedTerminalScrollReports: number;
  maxEmbeddedTerminalScrollMs: number;
  embeddedTerminalSnapshotWriteReports: number;
  maxEmbeddedTerminalSnapshotWriteMs: number;
  maxEmbeddedTerminalSnapshotBytes: number;
};

export function createRendererUiPerfCounters(): RendererUiPerfCounters {
  return {
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererHiddenEventLoopLagMs: 0,
    maxRendererCumulativeLagMs: 0,
    maxRendererTickDeltaMs: 0,
    maxRendererLongTaskMs: 0,
    planningTypingLagReports: 0,
    maxPlanningTypingLagMs: 0,
    planningChatInputChangeReports: 0,
    maxPlanningChatInputHandlerMs: 0,
    planningChatInputCommitReports: 0,
    maxPlanningChatInputCommitMs: 0,
    planningChatTranscriptCommitReports: 0,
    maxPlanningChatTranscriptCommitMs: 0,
    maxPlanningChatTranscriptLines: 0,
    maxPlanningChatTranscriptChars: 0,
    planningChatTranscriptAutoscrollReports: 0,
    maxPlanningChatTranscriptAutoscrollMs: 0,
    planningChatSubmits: 0,
    embeddedTerminalAttachReports: 0,
    maxEmbeddedTerminalAttachMs: 0,
    embeddedTerminalOpenRequestReports: 0,
    maxEmbeddedTerminalOpenRequestMs: 0,
    embeddedTerminalOpenExistingReports: 0,
    maxEmbeddedTerminalOpenExistingMs: 0,
    embeddedTerminalTabSelectReports: 0,
    maxEmbeddedTerminalTabSelectMs: 0,
    embeddedTerminalDrawerCycleReports: 0,
    maxEmbeddedTerminalDrawerCycleMs: 0,
    embeddedTerminalCloseReports: 0,
    maxEmbeddedTerminalCloseMs: 0,
    embeddedTerminalInputReports: 0,
    maxEmbeddedTerminalInputMs: 0,
    maxEmbeddedTerminalInputBytes: 0,
    embeddedTerminalOutputWriteReports: 0,
    maxEmbeddedTerminalOutputWriteMs: 0,
    maxEmbeddedTerminalOutputWriteBytes: 0,
    embeddedTerminalResizeReports: 0,
    maxEmbeddedTerminalResizeMs: 0,
    embeddedTerminalScrollReports: 0,
    maxEmbeddedTerminalScrollMs: 0,
    embeddedTerminalSnapshotWriteReports: 0,
    maxEmbeddedTerminalSnapshotWriteMs: 0,
    maxEmbeddedTerminalSnapshotBytes: 0,
  };
}

export function resetRendererUiPerfCounters(counters: RendererUiPerfCounters): void {
  const initial = createRendererUiPerfCounters();
  for (const key of Object.keys(initial) as Array<keyof RendererUiPerfCounters>) {
    counters[key] = initial[key];
  }
}

function numberField(data: Record<string, unknown> | undefined, key: string): number | null {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function updateMax(
  counters: RendererUiPerfCounters,
  key: keyof RendererUiPerfCounters,
  value: number | null,
): void {
  if (value === null) return;
  counters[key] = Math.max(counters[key], value);
}

export function recordRendererUiPerfMetric(
  counters: RendererUiPerfCounters,
  metric: string,
  data?: Record<string, unknown>,
): void {
  counters.rendererReports += 1;

  if (metric === 'renderer_event_loop_lag') {
    const lagMs = numberField(data, 'lagMs');
    if (lagMs !== null) {
      const hiddenOrUnfocused = data?.visibilityState === 'hidden' || data?.hasFocus === false;
      updateMax(
        counters,
        hiddenOrUnfocused ? 'maxRendererHiddenEventLoopLagMs' : 'maxRendererEventLoopLagMs',
        lagMs,
      );
    }
    updateMax(counters, 'maxRendererCumulativeLagMs', numberField(data, 'cumulativeLagMs'));
    updateMax(counters, 'maxRendererTickDeltaMs', numberField(data, 'tickDeltaMs'));
    return;
  }

  if (metric === 'renderer_long_task') {
    updateMax(counters, 'maxRendererLongTaskMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'planning_typing_lag_baseline') {
    counters.planningTypingLagReports += 1;
    updateMax(counters, 'maxPlanningTypingLagMs', numberField(data, 'lagMs'));
    return;
  }

  if (metric === 'planning_chat_input_change') {
    counters.planningChatInputChangeReports += 1;
    updateMax(counters, 'maxPlanningChatInputHandlerMs', numberField(data, 'handlerDurationMs'));
    return;
  }

  if (metric === 'planning_chat_input_commit') {
    counters.planningChatInputCommitReports += 1;
    updateMax(counters, 'maxPlanningChatInputCommitMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'planning_chat_transcript_commit') {
    counters.planningChatTranscriptCommitReports += 1;
    updateMax(counters, 'maxPlanningChatTranscriptCommitMs', numberField(data, 'durationMs'));
    updateMax(counters, 'maxPlanningChatTranscriptLines', numberField(data, 'lineCount'));
    updateMax(counters, 'maxPlanningChatTranscriptChars', numberField(data, 'transcriptChars'));
    return;
  }

  if (metric === 'planning_chat_transcript_autoscroll') {
    counters.planningChatTranscriptAutoscrollReports += 1;
    updateMax(counters, 'maxPlanningChatTranscriptAutoscrollMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'planning_chat_submit') {
    counters.planningChatSubmits += 1;
    return;
  }

  if (metric === 'embedded_terminal_attach') {
    counters.embeddedTerminalAttachReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalAttachMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_open_request') {
    counters.embeddedTerminalOpenRequestReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalOpenRequestMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_open_existing') {
    counters.embeddedTerminalOpenExistingReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalOpenExistingMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_tab_select') {
    counters.embeddedTerminalTabSelectReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalTabSelectMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_drawer_cycle') {
    counters.embeddedTerminalDrawerCycleReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalDrawerCycleMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_close') {
    counters.embeddedTerminalCloseReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalCloseMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_input') {
    counters.embeddedTerminalInputReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalInputMs', numberField(data, 'durationMs'));
    updateMax(counters, 'maxEmbeddedTerminalInputBytes', numberField(data, 'bytes'));
    return;
  }

  if (metric === 'embedded_terminal_output_write') {
    counters.embeddedTerminalOutputWriteReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalOutputWriteMs', numberField(data, 'durationMs'));
    updateMax(counters, 'maxEmbeddedTerminalOutputWriteBytes', numberField(data, 'bytes'));
    return;
  }

  if (metric === 'embedded_terminal_resize') {
    counters.embeddedTerminalResizeReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalResizeMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_scroll') {
    counters.embeddedTerminalScrollReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalScrollMs', numberField(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_snapshot_write') {
    counters.embeddedTerminalSnapshotWriteReports += 1;
    updateMax(counters, 'maxEmbeddedTerminalSnapshotWriteMs', numberField(data, 'durationMs'));
    updateMax(counters, 'maxEmbeddedTerminalSnapshotBytes', numberField(data, 'bytes'));
  }
}
