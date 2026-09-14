import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from './worker-decision-ledger.js';

/**
 * Durable, per-task cap on how many automatic recovery retries the workers may
 * submit for a single task, enforced against the configured `autoFixRetries`.
 *
 * Why this exists (incident 2026-07-12): the auto-fix recovery loop counted
 * attempts in an in-memory ledger keyed by `taskId:generation:attemptId`. Every
 * bare retry re-runs the task, which bumps `generation`, so the ledger key
 * changed on each retry and the budget reset to zero every single time. Bare
 * retries also never consumed the ledger at all. The result was an unbounded
 * retry loop (observed: one task retried 446 times over 36h, budget was 3) that
 * burned API budget and filled worker disks. The in-memory ledger also reset on
 * every app restart.
 *
 * This counter is stored in the durable `worker_actions` table under a key that
 * is stable across generations, attempts, and process restarts, so the total
 * number of worker-initiated retries for a task can never exceed the config.
 * Both automatic retry kinds (bare `retry-task` and `fix-with-agent`) count,
 * and every worker shares the one counter so the cap is per-task, not
 * per-worker. It is a hard cap across restarts and generation bumps. Recreate-
 * class lifecycle resets deliberately clear it for the affected task; a human
 * who wants more attempts can also use the explicit `fix` command, which
 * bypasses the worker entirely.
 */
export const AUTO_FIX_RETRY_CAP_ACTION_TYPE = 'auto-retry-cap';

/**
 * Single durable namespace for the cap counter, shared by every worker so a
 * task's retries are counted together rather than once per worker kind.
 */
const RETRY_CAP_WORKER_KIND = 'autofix';
const BARE_RETRY_ACTION_TYPE = 'auto-retry';

/** Stable per-task external key — deliberately free of generation/attempt. */
export function autoFixRetryCapExternalKey(taskId: string): string {
  return `retry-cap:${taskId}`;
}

/** Stable per-task external key for the once-per-task bare retry marker. */
export function autoFixBareRetryExternalKey(taskId: string): string {
  return `${RETRY_CAP_WORKER_KIND}:retry:${taskId}`;
}

export interface AutoFixRetryCapDecision {
  /** True when another retry is permitted under the configured budget. */
  readonly allowed: boolean;
  /** Retries already consumed durably for this task. */
  readonly consumed: number;
  /** Normalized budget (`Number.POSITIVE_INFINITY` means unlimited). */
  readonly budget: number;
}

/**
 * Decide whether a worker may submit one more automatic retry for `taskId`
 * without exceeding the configured budget. Read-only: callers must invoke
 * {@link recordAutoFixRetryConsumed} after the queue acknowledges submission so
 * the durable counter advances.
 */
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

export function recordAutoFixRetryPending(
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
    status: 'pending',
    summary: fields.summary ?? 'Automatic retry request awaiting queue acknowledgement',
    incrementAttempt: false,
    payload: { dispatchState: 'pending' },
  });
}

export function recordAutoFixRetryUnacknowledged(
  store: WorkerDecisionStore,
  taskId: string,
  error: unknown,
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
    status: 'failed',
    summary: fields.summary ?? 'Automatic retry request was not acknowledged',
    incrementAttempt: false,
    payload: {
      dispatchState: 'not-acknowledged',
      failurePhase: 'submission',
      error: error instanceof Error ? error.message : String(error),
    },
  });
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
    payload: { dispatchState: 'acknowledged' },
  });
}

/** Clear the durable retry cap after a recreate-class task reset. */
export function resetAutoFixRetryCap(store: WorkerDecisionStore, taskId: string): void {
  const externalKey = autoFixRetryCapExternalKey(taskId);
  const existing = store.getWorkerAction?.(RETRY_CAP_WORKER_KIND, externalKey);
  store.upsertWorkerAction?.({
    id: existing?.id ?? `${RETRY_CAP_WORKER_KIND}:${externalKey}`,
    workerKind: RETRY_CAP_WORKER_KIND,
    actionType: AUTO_FIX_RETRY_CAP_ACTION_TYPE,
    ...(existing?.workflowId !== undefined ? { workflowId: existing.workflowId } : {}),
    taskId,
    subjectType: 'task',
    subjectId: taskId,
    externalKey,
    status: 'queued',
    attemptCount: 0,
    summary: 'Durable per-task auto-fix retry counter',
    updatedAt: new Date().toISOString(),
  });
}

/** Clear the once-per-task bare retry marker after a recreate-class task reset. */
export function resetAutoFixBareRetry(store: WorkerDecisionStore, taskId: string): void {
  const externalKey = autoFixBareRetryExternalKey(taskId);
  const existing = store.getWorkerAction?.(RETRY_CAP_WORKER_KIND, externalKey);
  store.upsertWorkerAction?.({
    id: existing?.id ?? `${RETRY_CAP_WORKER_KIND}:${externalKey}`,
    workerKind: RETRY_CAP_WORKER_KIND,
    actionType: BARE_RETRY_ACTION_TYPE,
    ...(existing?.workflowId !== undefined ? { workflowId: existing.workflowId } : {}),
    taskId,
    subjectType: 'task',
    subjectId: taskId,
    externalKey,
    status: 'queued',
    attemptCount: 0,
    summary: 'Once-per-task auto-fix bare retry marker',
    updatedAt: new Date().toISOString(),
  });
}

/** Reset all automatic recovery budget state for recreated tasks. */
export function resetAutoFixBudgetForTasks(store: WorkerDecisionStore, taskIds: readonly string[]): void {
  for (const taskId of taskIds) {
    resetAutoFixRetryCap(store, taskId);
    resetAutoFixBareRetry(store, taskId);
  }
}
