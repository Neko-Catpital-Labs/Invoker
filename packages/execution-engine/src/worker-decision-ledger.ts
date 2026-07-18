import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';

export interface WorkerDecisionStore {
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

const TERMINAL_ACTION_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  skipped: true,
  abandoned: true,
  cancelled: true,
};

const ROUTINE_SKIP_REASONS: Record<string, true> = {
  'task-not-found': true,
  'stale-workflow': true,
  'stale-generation': true,
  'stale-task-state-version': true,
  'stale-attempt': true,
  'workflow-changed': true,
  'status-changed': true,
  'review-changed': true,
  'generation-changed': true,
  'selected-attempt-changed': true,
  'head-sha-changed': true,
  'branch-changed': true,
  'already-queued-intent': true,
  'already-recorded': true,
  'duplicate-candidate': true,
  'lock-held': true,
  'flock-held': true,
  'mkdir-lock-held': true,
  'mkdir-lock-held-without-pid': true,
};

export function isMeaningfulSkipReason(reason: string): boolean {
  return ROUTINE_SKIP_REASONS[reason] !== true;
}

export interface WorkerDecisionRow {
  workerKind: string;
  actionType: string;
  externalKey: string;
  subjectType: string;
  subjectId: string;
  status: WorkerActionStatus;
  workflowId?: string;
  taskId?: string;
  summary: string;
  reason?: string;
  intentId?: number | string;
  agentName?: string;
  executionModel?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  incrementAttempt?: boolean;
  now?: string;
}

export function recordWorkerDecisionRow(
  store: WorkerDecisionStore,
  row: WorkerDecisionRow,
): WorkerActionRecord | undefined {
  if (!store.upsertWorkerAction) return undefined;
  const existing = store.getWorkerAction?.(row.workerKind, row.externalKey);
  const now = row.now ?? new Date().toISOString();
  const attemptCount = row.incrementAttempt
    ? (existing?.attemptCount ?? 0) + 1
    : existing?.attemptCount ?? 0;
  return store.upsertWorkerAction({
    id: existing?.id ?? `${row.workerKind}:${row.externalKey}`,
    workerKind: row.workerKind,
    actionType: row.actionType,
    ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
    ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    externalKey: row.externalKey,
    status: row.status,
    attemptCount,
    ...(row.intentId !== undefined ? { intentId: String(row.intentId) } : {}),
    ...(row.agentName !== undefined ? { agentName: row.agentName } : {}),
    ...(row.executionModel !== undefined ? { executionModel: row.executionModel } : {}),
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
    summary: row.summary,
    payload: {
      ...(row.reason !== undefined ? { reason: row.reason } : {}),
      ...row.payload,
    },
    updatedAt: now,
    ...(TERMINAL_ACTION_STATUSES[row.status] ? { completedAt: now } : {}),
  });
}
