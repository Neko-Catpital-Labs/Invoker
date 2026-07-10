export type RendererUiPerfCounters = {
  rendererReports: number;
  maxRendererEventLoopLagMs: number;
  maxRendererHiddenEventLoopLagMs: number;
  maxRendererCumulativeLagMs: number;
  maxRendererTickDeltaMs: number;
  maxRendererLongTaskMs: number;
  planningChatInputChanges: number;
  planningChatInputCommits: number;
  planningChatRenderCommits: number;
  maxPlanningChatInputHandlerMs: number;
  maxPlanningChatInputCommitMs: number;
  maxPlanningChatRenderCommitMs: number;
  maxPlanningChatValueLength: number;
  maxPlanningChatLineCount: number;
  terminalRendererAttaches: number;
  maxTerminalRendererAttachMs: number;
  terminalRendererOutputWrites: number;
  terminalRendererOutputBursts: number;
  maxTerminalRendererOutputWriteMs: number;
  maxTerminalRendererOutputChunkBytes: number;
  maxTerminalRendererOutputWindowBytes: number;
  terminalRendererOutputSeeds: number;
  maxTerminalRendererOutputSeedMs: number;
  maxTerminalRendererOutputSeedBytes: number;
};

export function createRendererUiPerfCounters(): RendererUiPerfCounters {
  return {
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererHiddenEventLoopLagMs: 0,
    maxRendererCumulativeLagMs: 0,
    maxRendererTickDeltaMs: 0,
    maxRendererLongTaskMs: 0,
    planningChatInputChanges: 0,
    planningChatInputCommits: 0,
    planningChatRenderCommits: 0,
    maxPlanningChatInputHandlerMs: 0,
    maxPlanningChatInputCommitMs: 0,
    maxPlanningChatRenderCommitMs: 0,
    maxPlanningChatValueLength: 0,
    maxPlanningChatLineCount: 0,
    terminalRendererAttaches: 0,
    maxTerminalRendererAttachMs: 0,
    terminalRendererOutputWrites: 0,
    terminalRendererOutputBursts: 0,
    maxTerminalRendererOutputWriteMs: 0,
    maxTerminalRendererOutputChunkBytes: 0,
    maxTerminalRendererOutputWindowBytes: 0,
    terminalRendererOutputSeeds: 0,
    maxTerminalRendererOutputSeedMs: 0,
    maxTerminalRendererOutputSeedBytes: 0,
  };
}

export function resetRendererUiPerfCounters(counters: RendererUiPerfCounters): void {
  Object.assign(counters, createRendererUiPerfCounters());
}

function numeric(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function maxNumeric<K extends keyof RendererUiPerfCounters>(
  counters: RendererUiPerfCounters,
  key: K,
  value: number | undefined,
): void {
  if (value === undefined) return;
  counters[key] = Math.max(counters[key], value) as RendererUiPerfCounters[K];
}

export function recordRendererUiPerfMetric(
  counters: RendererUiPerfCounters,
  metric: string,
  data?: Record<string, unknown>,
): void {
  counters.rendererReports += 1;

  if (metric === 'renderer_event_loop_lag') {
    const lagMs = numeric(data, 'lagMs');
    const hiddenOrUnfocused = data?.visibilityState === 'hidden' || data?.hasFocus === false;
    if (hiddenOrUnfocused) {
      maxNumeric(counters, 'maxRendererHiddenEventLoopLagMs', lagMs);
    } else {
      maxNumeric(counters, 'maxRendererEventLoopLagMs', lagMs);
    }
    maxNumeric(counters, 'maxRendererCumulativeLagMs', numeric(data, 'cumulativeLagMs'));
    maxNumeric(counters, 'maxRendererTickDeltaMs', numeric(data, 'tickDeltaMs'));
    return;
  }

  if (metric === 'renderer_long_task') {
    maxNumeric(counters, 'maxRendererLongTaskMs', numeric(data, 'durationMs'));
    return;
  }

  if (metric === 'planning_chat_input_change') {
    counters.planningChatInputChanges += 1;
    maxNumeric(counters, 'maxPlanningChatInputHandlerMs', numeric(data, 'durationMs'));
    maxNumeric(counters, 'maxPlanningChatValueLength', numeric(data, 'valueLength'));
    maxNumeric(counters, 'maxPlanningChatLineCount', numeric(data, 'lineCount'));
    return;
  }

  if (metric === 'planning_chat_input_commit') {
    counters.planningChatInputCommits += 1;
    maxNumeric(counters, 'maxPlanningChatInputCommitMs', numeric(data, 'durationMs'));
    maxNumeric(counters, 'maxPlanningChatInputHandlerMs', numeric(data, 'handlerMs'));
    maxNumeric(counters, 'maxPlanningChatValueLength', numeric(data, 'valueLength'));
    maxNumeric(counters, 'maxPlanningChatLineCount', numeric(data, 'lineCount'));
    return;
  }

  if (metric === 'planning_chat_render_commit') {
    counters.planningChatRenderCommits += 1;
    maxNumeric(counters, 'maxPlanningChatRenderCommitMs', numeric(data, 'durationMs'));
    maxNumeric(counters, 'maxPlanningChatValueLength', numeric(data, 'valueLength'));
    maxNumeric(counters, 'maxPlanningChatLineCount', numeric(data, 'lineCount'));
    return;
  }

  if (metric === 'terminal_renderer_attach') {
    counters.terminalRendererAttaches += 1;
    maxNumeric(counters, 'maxTerminalRendererAttachMs', numeric(data, 'durationMs'));
    return;
  }

  if (metric === 'terminal_renderer_output_write') {
    counters.terminalRendererOutputWrites += 1;
    if (data?.burst === true) {
      counters.terminalRendererOutputBursts += 1;
    }
    maxNumeric(counters, 'maxTerminalRendererOutputWriteMs', numeric(data, 'durationMs'));
    maxNumeric(counters, 'maxTerminalRendererOutputChunkBytes', numeric(data, 'bytes'));
    maxNumeric(counters, 'maxTerminalRendererOutputWindowBytes', numeric(data, 'bytesInWindow'));
    return;
  }

  if (metric === 'terminal_renderer_output_seed') {
    counters.terminalRendererOutputSeeds += 1;
    maxNumeric(counters, 'maxTerminalRendererOutputSeedMs', numeric(data, 'durationMs'));
    maxNumeric(counters, 'maxTerminalRendererOutputSeedBytes', numeric(data, 'bytes'));
  }
}
