import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from './worker-decision-ledger.js';

export const REQUEUE_RETRY_CAP_ACTION_TYPE = 'stall-requeue-cap';

const REQUEUE_RETRY_CAP_WORKER_KIND = 'requeue';

export function requeueRetryCapExternalKey(taskId: string): string {
  return `stall-requeue-cap:${taskId}`;
}

export interface RequeueRetryCapDecision {
  readonly allowed: boolean;
  readonly consumed: number;
  readonly budget: number;
}

export function checkRequeueRetryCap(
  store: WorkerDecisionStore,
  taskId: string,
  rawBudget: unknown,
): RequeueRetryCapDecision {
  const budget = normalizeAutoFixRetryBudget(rawBudget);
  const consumed = store.getWorkerAction?.(
    REQUEUE_RETRY_CAP_WORKER_KIND,
    requeueRetryCapExternalKey(taskId),
  )?.attemptCount ?? 0;
  const allowed = budget === Number.POSITIVE_INFINITY || (budget > 0 && consumed < budget);
  return { allowed, consumed, budget };
}

export function recordRequeueRetryConsumed(
  store: WorkerDecisionStore,
  taskId: string,
  fields: { workflowId?: string; summary?: string } = {},
): void {
  recordWorkerDecisionRow(store, {
    workerKind: REQUEUE_RETRY_CAP_WORKER_KIND,
    actionType: REQUEUE_RETRY_CAP_ACTION_TYPE,
    externalKey: requeueRetryCapExternalKey(taskId),
    subjectType: 'task',
    subjectId: taskId,
    ...(fields.workflowId !== undefined ? { workflowId: fields.workflowId } : {}),
    taskId,
    status: 'queued',
    summary: fields.summary ?? 'Durable per-task requeue retry counter',
    incrementAttempt: true,
  });
}
