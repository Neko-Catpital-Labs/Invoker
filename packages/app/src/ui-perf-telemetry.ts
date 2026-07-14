export const PLANNING_TYPING_LAG_METRIC = 'planning_typing_lag_baseline';

export interface UiPerfTelemetryStats {
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
  planningTypingLagReports: number;
  maxPlanningTypingLagMs: number;
  lastPlanningTypingLagMs: number;
  maxPlanningTypingLagContext: Record<string, unknown> | null;
  lastPlanningTypingLagContext: Record<string, unknown> | null;
}

const PLANNING_TYPING_LAG_CONTEXT_KEYS = [
  'scenario',
  'sessionCount',
  'transcriptSizeBytes',
  'transcriptMessageCount',
  'taskCount',
  'workflowCount',
  'taskStatusCounts',
  'activeSurface',
  'activeState',
  'viewMode',
  'terminalDrawerState',
  'selectionState',
  'selectedTaskId',
  'selectedWorkflowId',
  'hasLoadedPlan',
  'hasStarted',
  'sequence',
  'eventType',
  'targetName',
  'targetTagName',
  'targetValueLength',
  'targetReadOnly',
  'targetDisabled',
  'targetIsComposing',
  'inputType',
] as const;

export function createUiPerfTelemetryStats(): UiPerfTelemetryStats {
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
    planningTypingLagReports: 0,
    maxPlanningTypingLagMs: 0,
    lastPlanningTypingLagMs: 0,
    maxPlanningTypingLagContext: null,
    lastPlanningTypingLagContext: null,
  };
}

export function resetUiPerfTelemetryStats(stats: UiPerfTelemetryStats): void {
  Object.assign(stats, createUiPerfTelemetryStats());
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function planningTypingLagContext(
  lagMs: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const context: Record<string, unknown> = { lagMs };
  for (const key of PLANNING_TYPING_LAG_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      context[key] = data[key];
    }
  }
  return context;
}

export function recordUiPerfTelemetryReport(
  stats: UiPerfTelemetryStats,
  metric: string,
  data?: Record<string, unknown>,
): void {
  if (metric === 'renderer_event_loop_lag') {
    const lagMs = finiteNumber(data?.lagMs);
    if (lagMs !== undefined) {
      const hiddenOrUnfocused = data?.visibilityState === 'hidden' || data?.hasFocus === false;
      if (hiddenOrUnfocused) {
        stats.maxRendererHiddenEventLoopLagMs = Math.max(stats.maxRendererHiddenEventLoopLagMs, lagMs);
      } else {
        stats.maxRendererEventLoopLagMs = Math.max(stats.maxRendererEventLoopLagMs, lagMs);
      }
    }
    const cumulativeLagMs = finiteNumber(data?.cumulativeLagMs);
    if (cumulativeLagMs !== undefined) {
      stats.maxRendererCumulativeLagMs = Math.max(stats.maxRendererCumulativeLagMs, cumulativeLagMs);
    }
    const tickDeltaMs = finiteNumber(data?.tickDeltaMs);
    if (tickDeltaMs !== undefined) {
      stats.maxRendererTickDeltaMs = Math.max(stats.maxRendererTickDeltaMs, tickDeltaMs);
    }
  }

  if (metric === 'renderer_long_task') {
    const durationMs = finiteNumber(data?.durationMs);
    if (durationMs !== undefined) {
      stats.maxRendererLongTaskMs = Math.max(stats.maxRendererLongTaskMs, durationMs);
    }
  }

  if (metric === PLANNING_TYPING_LAG_METRIC) {
    const lagMs = finiteNumber(data?.lagMs);
    if (lagMs !== undefined && data) {
      const context = planningTypingLagContext(lagMs, data);
      stats.planningTypingLagReports += 1;
      stats.lastPlanningTypingLagMs = lagMs;
      stats.lastPlanningTypingLagContext = context;
      if (lagMs >= stats.maxPlanningTypingLagMs) {
        stats.maxPlanningTypingLagMs = lagMs;
        stats.maxPlanningTypingLagContext = context;
      }
    }
  }

  stats.rendererReports += 1;
}
