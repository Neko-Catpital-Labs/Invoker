import { FailureClassifier, type TaskState } from '@invoker/workflow-core';

export function normalizeAutoFixRetryBudget(raw: unknown): number {
  if (raw === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0;
  }
  const budget = Math.floor(raw);
  return budget > 0 ? budget : 0;
}


export function shouldSkipAutoFixForError(errorText: unknown): boolean {
  return FailureClassifier.isCancellation(errorText);
}

export function isLivenessFailureTask(task: Pick<TaskState, 'execution'>): boolean {
  return FailureClassifier.isLiveness(task.execution.failureClass);
}

export function isSshOauthExpiredFailureTask(task: Pick<TaskState, 'execution'>): boolean {
  return task.execution.failureClass === 'ssh-oauth-session-expired';
}

export function isRequeueEligibleFailureTask(task: Pick<TaskState, 'execution'>): boolean {
  return isLivenessFailureTask(task) || isSshOauthExpiredFailureTask(task);
}
