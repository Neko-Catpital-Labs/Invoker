/**
 * Shared dispatcher for the owner's `headless.query` IPC channel.
 *
 * Non-owner processes read database-derived state by sending a
 * `{ kind }`-discriminated request over IpcBus; the writable owner answers it.
 * The GUI owner and the standalone headless owner previously each carried an
 * identical if-chain — this is the single place that maps a query kind to a
 * response, so new read kinds (the sole-owner rearchitecture routes every read
 * through here) are added once and stay consistent across both owners.
 *
 * The per-owner differences (owner label, task-delta stream sequence, the
 * standalone keep-alive ping, the ui-perf source) are injected via handlers.
 */
export interface OwnerReadQueryHandlers {
  /** Label echoed back on the ui-perf response ('gui' | 'standalone'). */
  ownerModeLabel: string;
  /** Called once per query (the standalone owner uses it to defer idle shutdown). */
  onActivity?: () => void;
  getUiPerfStats: () => Record<string, unknown>;
  resetUiPerfStats: () => void;
  getQueueStatus: () => Record<string, unknown>;
  getWorkflowStatus: () => Record<string, unknown>;
  /** Build the task/workflow snapshot; `refresh` re-syncs the orchestrator from the DB first. */
  getTasksSnapshot: (opts: { refresh: boolean }) => Record<string, unknown>;
  getActionGraphSnapshot: () => Record<string, unknown>;
}

export function answerOwnerReadQuery(
  req: unknown,
  handlers: OwnerReadQueryHandlers,
): Record<string, unknown> {
  const { kind, reset } = (req ?? {}) as { kind?: string; reset?: boolean };
  handlers.onActivity?.();

  switch (kind) {
    case 'ui-perf':
      if (reset) handlers.resetUiPerfStats();
      return { ownerMode: handlers.ownerModeLabel, ...handlers.getUiPerfStats() };
    case 'queue':
      return handlers.getQueueStatus();
    case 'workflow-status':
      return handlers.getWorkflowStatus();
    case 'tasks':
      return handlers.getTasksSnapshot({ refresh: false });
    case 'task-graph-refresh':
      return handlers.getTasksSnapshot({ refresh: true });
    case 'action-graph':
      return handlers.getActionGraphSnapshot();
    default:
      throw new Error(`Unsupported headless query: ${String(kind)}`);
  }
}
