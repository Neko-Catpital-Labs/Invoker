import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
} from '@invoker/data-store';

export type TerminalWorkerActionReconcileStore = {
  listWorkerActions(filters?: WorkerActionListFilters): WorkerActionRecord[];
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
};

const OPEN_STATUSES: WorkerActionStatus[] = ['queued', 'pending', 'running'];

function firstLine(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const line = value.split('\n').map((part) => part.trim()).find(Boolean);
  return line || undefined;
}

/**
 * Fold terminal mutation-intent outcomes into open worker_actions rows.
 *
 * Tick-time workers only reconcile when they drain a lifecycle event. After
 * owner SIGKILL mid-tick, a queued action can outlive a completed/failed
 * intent until this startup sweep runs.
 */
export function reconcileTerminalWorkerActionsOnStartup(
  store: TerminalWorkerActionReconcileStore,
  now: Date = new Date(),
): number {
  if (!store.upsertWorkerAction || !store.listWorkflowMutationIntents) {
    return 0;
  }

  const seen = new Set<string>();
  const open: WorkerActionRecord[] = [];
  for (const status of OPEN_STATUSES) {
    for (const action of store.listWorkerActions({ status })) {
      if (seen.has(action.id)) continue;
      seen.add(action.id);
      open.push(action);
    }
  }

  let reconciled = 0;
  const nowIso = now.toISOString();
  for (const action of open) {
    if (!action.intentId) continue;
    const terminalIntents = store.listWorkflowMutationIntents(action.workflowId, ['completed', 'failed']);
    const intent = terminalIntents.find((candidate) => String(candidate.id) === action.intentId);
    if (!intent) continue;

    const status: WorkerActionStatus = intent.status === 'completed' ? 'completed' : 'failed';
    const summary = status === 'completed'
      ? 'Worker action reconciled from completed intent on startup'
      : `Worker action reconciled from failed intent on startup: ${firstLine(intent.error) ?? 'unknown error'}`;
    const payload = action.payload && typeof action.payload === 'object'
      ? { ...(action.payload as Record<string, unknown>) }
      : {};

    store.upsertWorkerAction({
      ...action,
      status,
      summary,
      payload: {
        ...payload,
        reconciledIntentStatus: intent.status,
        reconciledAtStartup: true,
        intentError: intent.error ?? null,
      },
      updatedAt: nowIso,
      completedAt: nowIso,
    });
    reconciled += 1;
  }

  return reconciled;
}
