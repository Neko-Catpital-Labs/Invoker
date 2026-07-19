import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from './worker-decision-ledger.js';

export const AUTO_FIX_RETRY_CAP_ACTION_TYPE = 'auto-retry-cap';

const RETRY_CAP_WORKER_KIND = 'autofix';

export function autoFixRetryCapExternalKey(taskId: string): string {
  return `retry-cap:${taskId}`;
}

export interface AutoFixRetryCapDecision {
  readonly allowed: boolean;
  readonly consumed: number;
  readonly budget: number;
}

export function checkAutoFixRetryCap(
  store: WorkerDecisionStore,
  taskId: string,
  rawBudget: unknown,
): AutoFixRetryCapDecision {
  const budget = normalizeAutoFixRetryBudget(rawBudget);
  const consumed = store.getWorkerAction?.(RETRY_CAP_WORKER_KIND, autoFixRetryCapExternalKey(taskId))?.attemptCount ?? 0;
  const allowed = budget === Number.POSITIVE_INFINITY || (budget > 0 && consumed < budget);
  return { allowed, consumed, budget };
}

export function recordAutoFixRetryConsumed(
  store: WorkerDecisionStore,
  taskId: string,
  fields: { workflowId?: string; summary?: string } = {},
): void {
  recordWorkerDecisionRow(store, {
    workerKind: RETRY_CAP_WORKER_KIND,
    actionType: AUTO_FIX_RETRY_CAP_ACTION_TYPE,
    externalKey: autoFixRetryCapExternalKey(taskId),
    subjectType: 'task',
    subjectId: taskId,
    ...(fields.workflowId !== undefined ? { workflowId: fields.workflowId } : {}),
    taskId,
    status: 'queued',
    summary: fields.summary ?? 'Durable per-task auto-fix retry counter',
    incrementAttempt: true,
  });
}
