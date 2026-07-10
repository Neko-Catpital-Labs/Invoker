/**
 * Shared owner-side rollups for renderer-originated ui-perf metrics.
 *
 * Raw payloads are still persisted by main.ts. These counters keep
 * `query ui-perf` useful without changing the renderer IPC contract.
 */

export type RendererUiPerfCounters = {
  rendererReports: number;
  maxRendererEventLoopLagMs: number;
  maxRendererHiddenEventLoopLagMs: number;
  maxRendererCumulativeLagMs: number;
  maxRendererTickDeltaMs: number;
  maxRendererLongTaskMs: number;
  planningChatInputChangeCount: number;
  planningChatRenderCommitCount: number;
  maxPlanningChatInputChangeMs: number;
  maxPlanningChatInputToCommitMs: number;
  maxPlanningChatRenderCommitMs: number;
  maxPlanningChatValueLength: number;
  maxPlanningChatLineCount: number;
  rendererTerminalAttachCount: number;
  rendererTerminalSnapshotSeedCount: number;
  rendererTerminalOutputWriteCount: number;
  rendererTerminalOutputBurstCount: number;
  maxRendererTerminalAttachMs: number;
  maxRendererTerminalSnapshotSeedMs: number;
  maxRendererTerminalSnapshotSeedBytes: number;
  maxRendererTerminalOutputWriteMs: number;
  maxRendererTerminalOutputChunkBytes: number;
  maxRendererTerminalOutputBurstCount: number;
  maxRendererTerminalOutputBurstBytes: number;
  maxRendererTerminalOutputBurstWriteMs: number;
  rendererTerminalOutputBurstBytes: number;
};

export function createRendererUiPerfCounters(): RendererUiPerfCounters {
  return {
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererHiddenEventLoopLagMs: 0,
    maxRendererCumulativeLagMs: 0,
    maxRendererTickDeltaMs: 0,
    maxRendererLongTaskMs: 0,
    planningChatInputChangeCount: 0,
    planningChatRenderCommitCount: 0,
    maxPlanningChatInputChangeMs: 0,
    maxPlanningChatInputToCommitMs: 0,
    maxPlanningChatRenderCommitMs: 0,
    maxPlanningChatValueLength: 0,
    maxPlanningChatLineCount: 0,
    rendererTerminalAttachCount: 0,
    rendererTerminalSnapshotSeedCount: 0,
    rendererTerminalOutputWriteCount: 0,
    rendererTerminalOutputBurstCount: 0,
    maxRendererTerminalAttachMs: 0,
    maxRendererTerminalSnapshotSeedMs: 0,
    maxRendererTerminalSnapshotSeedBytes: 0,
    maxRendererTerminalOutputWriteMs: 0,
    maxRendererTerminalOutputChunkBytes: 0,
    maxRendererTerminalOutputBurstCount: 0,
    maxRendererTerminalOutputBurstBytes: 0,
    maxRendererTerminalOutputBurstWriteMs: 0,
    rendererTerminalOutputBurstBytes: 0,
  };
}

export function resetRendererUiPerfCounters(counters: RendererUiPerfCounters): void {
  Object.assign(counters, createRendererUiPerfCounters());
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maxCounter(counters: RendererUiPerfCounters, key: keyof RendererUiPerfCounters, value: unknown): void {
  const n = finiteNumber(value);
  if (n === null) return;
  counters[key] = Math.max(counters[key], n);
}

export function recordRendererUiPerfMetric(
  counters: RendererUiPerfCounters,
  metric: string,
  data?: Record<string, unknown>,
): void {
  counters.rendererReports += 1;

  if (metric === 'renderer_event_loop_lag') {
    const lagMs = finiteNumber(data?.lagMs);
    if (lagMs !== null) {
      const hiddenOrUnfocused = data?.visibilityState === 'hidden' || data?.hasFocus === false;
      if (hiddenOrUnfocused) {
        counters.maxRendererHiddenEventLoopLagMs = Math.max(counters.maxRendererHiddenEventLoopLagMs, lagMs);
      } else {
        counters.maxRendererEventLoopLagMs = Math.max(counters.maxRendererEventLoopLagMs, lagMs);
      }
    }
    maxCounter(counters, 'maxRendererCumulativeLagMs', data?.cumulativeLagMs);
    maxCounter(counters, 'maxRendererTickDeltaMs', data?.tickDeltaMs);
    return;
  }

  if (metric === 'renderer_long_task') {
    maxCounter(counters, 'maxRendererLongTaskMs', data?.durationMs);
    return;
  }

  if (metric === 'planning_chat_input_change') {
    counters.planningChatInputChangeCount += 1;
    maxCounter(counters, 'maxPlanningChatInputChangeMs', data?.durationMs);
    maxCounter(counters, 'maxPlanningChatValueLength', data?.valueLength);
    maxCounter(counters, 'maxPlanningChatLineCount', data?.lineCount);
    return;
  }

  if (metric === 'planning_chat_render_commit') {
    counters.planningChatRenderCommitCount += 1;
    maxCounter(counters, 'maxPlanningChatRenderCommitMs', data?.durationMs);
    maxCounter(counters, 'maxPlanningChatInputToCommitMs', data?.inputToCommitMs);
    maxCounter(counters, 'maxPlanningChatValueLength', data?.valueLength);
    maxCounter(counters, 'maxPlanningChatLineCount', data?.lineCount);
    return;
  }

  if (metric === 'terminal_attach') {
    counters.rendererTerminalAttachCount += 1;
    maxCounter(counters, 'maxRendererTerminalAttachMs', data?.durationMs);
    return;
  }

  if (metric === 'terminal_snapshot_seed') {
    counters.rendererTerminalSnapshotSeedCount += 1;
    maxCounter(counters, 'maxRendererTerminalSnapshotSeedMs', data?.durationMs);
    maxCounter(counters, 'maxRendererTerminalSnapshotSeedBytes', data?.bytes);
    return;
  }

  if (metric === 'terminal_output_write') {
    counters.rendererTerminalOutputWriteCount += 1;
    maxCounter(counters, 'maxRendererTerminalOutputWriteMs', data?.durationMs);
    maxCounter(counters, 'maxRendererTerminalOutputChunkBytes', data?.bytes);
    return;
  }

  if (metric === 'terminal_output_burst') {
    counters.rendererTerminalOutputBurstCount += 1;
    const bytes = finiteNumber(data?.bytes);
    if (bytes !== null) {
      counters.rendererTerminalOutputBurstBytes += bytes;
      counters.maxRendererTerminalOutputBurstBytes = Math.max(counters.maxRendererTerminalOutputBurstBytes, bytes);
    }
    maxCounter(counters, 'maxRendererTerminalOutputBurstCount', data?.outputCount);
    maxCounter(counters, 'maxRendererTerminalOutputBurstWriteMs', data?.maxWriteMs);
  }
}
