export interface UiPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
  dbPollUpdatedAsUpdated: number;
  rendererReports: number;
  maxRendererEventLoopLagMs: number;
  maxRendererHiddenEventLoopLagMs: number;
  maxRendererCumulativeLagMs: number;
  maxRendererTickDeltaMs: number;
  maxRendererLongTaskMs: number;
  workflowMetadataPublishRequests: number;
  workflowMetadataPublishes: number;
  workflowMetadataCoalescedRequests: number;
  largeTaskDeltaBatches: number;
  maxTaskDeltaBatchSize: number;
  planningChatInputChanges: number;
  planningChatInputCharsChanged: number;
  maxPlanningChatInputHandlerMs: number;
  maxPlanningChatInputValueLength: number;
  planningChatRenderCommits: number;
  maxPlanningChatRenderCommitMs: number;
  maxPlanningChatRenderLineCount: number;
  embeddedTerminalAttaches: number;
  maxEmbeddedTerminalAttachMs: number;
  embeddedTerminalInputWrites: number;
  embeddedTerminalInputBytes: number;
  maxEmbeddedTerminalInputBytes: number;
  embeddedTerminalOutputWrites: number;
  embeddedTerminalOutputBytes: number;
  embeddedTerminalLiveOutputBytes: number;
  embeddedTerminalSnapshotOutputBytes: number;
  maxEmbeddedTerminalOutputBytes: number;
  maxEmbeddedTerminalOutputWriteMs: number;
}

export function createUiPerfStats(): UiPerfStats {
  return {
    mainDeltaToUi: 0,
    dbPollCreated: 0,
    dbPollUpdatedAsCreated: 0,
    dbPollUpdatedAsUpdated: 0,
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererHiddenEventLoopLagMs: 0,
    maxRendererCumulativeLagMs: 0,
    maxRendererTickDeltaMs: 0,
    maxRendererLongTaskMs: 0,
    workflowMetadataPublishRequests: 0,
    workflowMetadataPublishes: 0,
    workflowMetadataCoalescedRequests: 0,
    largeTaskDeltaBatches: 0,
    maxTaskDeltaBatchSize: 0,
    planningChatInputChanges: 0,
    planningChatInputCharsChanged: 0,
    maxPlanningChatInputHandlerMs: 0,
    maxPlanningChatInputValueLength: 0,
    planningChatRenderCommits: 0,
    maxPlanningChatRenderCommitMs: 0,
    maxPlanningChatRenderLineCount: 0,
    embeddedTerminalAttaches: 0,
    maxEmbeddedTerminalAttachMs: 0,
    embeddedTerminalInputWrites: 0,
    embeddedTerminalInputBytes: 0,
    maxEmbeddedTerminalInputBytes: 0,
    embeddedTerminalOutputWrites: 0,
    embeddedTerminalOutputBytes: 0,
    embeddedTerminalLiveOutputBytes: 0,
    embeddedTerminalSnapshotOutputBytes: 0,
    maxEmbeddedTerminalOutputBytes: 0,
    maxEmbeddedTerminalOutputWriteMs: 0,
  };
}

export function resetUiPerfStatsAccumulator(stats: UiPerfStats): void {
  Object.assign(stats, createUiPerfStats());
}

function finiteNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function maxFinite(current: number, value: number | undefined): number {
  return value === undefined ? current : Math.max(current, value);
}

export function recordUiPerfMetric(
  stats: UiPerfStats,
  metric: string,
  data?: Record<string, unknown>,
): void {
  if (metric === 'renderer_event_loop_lag') {
    const lagMs = finiteNumber(data, 'lagMs');
    if (lagMs !== undefined) {
      const hiddenOrUnfocused = data?.visibilityState === 'hidden' || data?.hasFocus === false;
      if (hiddenOrUnfocused) {
        stats.maxRendererHiddenEventLoopLagMs = Math.max(stats.maxRendererHiddenEventLoopLagMs, lagMs);
      } else {
        stats.maxRendererEventLoopLagMs = Math.max(stats.maxRendererEventLoopLagMs, lagMs);
      }
    }
    stats.maxRendererCumulativeLagMs = maxFinite(stats.maxRendererCumulativeLagMs, finiteNumber(data, 'cumulativeLagMs'));
    stats.maxRendererTickDeltaMs = maxFinite(stats.maxRendererTickDeltaMs, finiteNumber(data, 'tickDeltaMs'));
    return;
  }

  if (metric === 'renderer_long_task') {
    stats.maxRendererLongTaskMs = maxFinite(stats.maxRendererLongTaskMs, finiteNumber(data, 'durationMs'));
    return;
  }

  if (metric === 'planning_chat_input_change') {
    stats.planningChatInputChanges += 1;
    const deltaChars = finiteNumber(data, 'deltaChars');
    if (deltaChars !== undefined) {
      stats.planningChatInputCharsChanged += Math.abs(deltaChars);
    }
    stats.maxPlanningChatInputHandlerMs = maxFinite(stats.maxPlanningChatInputHandlerMs, finiteNumber(data, 'handlerMs'));
    stats.maxPlanningChatInputValueLength = maxFinite(stats.maxPlanningChatInputValueLength, finiteNumber(data, 'valueLength'));
    return;
  }

  if (metric === 'planning_chat_render_commit') {
    stats.planningChatRenderCommits += 1;
    stats.maxPlanningChatRenderCommitMs = maxFinite(stats.maxPlanningChatRenderCommitMs, finiteNumber(data, 'durationMs'));
    stats.maxPlanningChatRenderLineCount = maxFinite(stats.maxPlanningChatRenderLineCount, finiteNumber(data, 'lineCount'));
    return;
  }

  if (metric === 'embedded_terminal_attach') {
    stats.embeddedTerminalAttaches += 1;
    stats.maxEmbeddedTerminalAttachMs = maxFinite(stats.maxEmbeddedTerminalAttachMs, finiteNumber(data, 'durationMs'));
    return;
  }

  if (metric === 'embedded_terminal_input_write') {
    stats.embeddedTerminalInputWrites += 1;
    const bytes = finiteNumber(data, 'bytes') ?? 0;
    stats.embeddedTerminalInputBytes += bytes;
    stats.maxEmbeddedTerminalInputBytes = Math.max(stats.maxEmbeddedTerminalInputBytes, bytes);
    return;
  }

  if (metric === 'embedded_terminal_output_write') {
    stats.embeddedTerminalOutputWrites += 1;
    const bytes = finiteNumber(data, 'bytes') ?? 0;
    stats.embeddedTerminalOutputBytes += bytes;
    if (data?.source === 'snapshot') {
      stats.embeddedTerminalSnapshotOutputBytes += bytes;
    } else if (data?.source === 'live') {
      stats.embeddedTerminalLiveOutputBytes += bytes;
    }
    stats.maxEmbeddedTerminalOutputBytes = Math.max(stats.maxEmbeddedTerminalOutputBytes, bytes);
    stats.maxEmbeddedTerminalOutputWriteMs = maxFinite(stats.maxEmbeddedTerminalOutputWriteMs, finiteNumber(data, 'durationMs'));
  }
}
