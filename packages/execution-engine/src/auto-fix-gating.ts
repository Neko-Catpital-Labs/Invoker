import { isLivenessFailureClass, type TaskState } from '@invoker/workflow-core';

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
  if (typeof errorText !== 'string') {
    return false;
  }
  return errorText.startsWith('Cancelled by user') || errorText.startsWith('Cancelled:')
    || errorText.startsWith('Terminated by user') || errorText.startsWith('Terminated:');
}

/**
 * True when the task's recorded failure is a liveness class (requeue, don't
 * auto-fix). A `liveness_stall` means a recovery guard force-failed a task whose
 * executor stopped heartbeating — the work itself was never proven broken, so an
 * AI "fix" would loop. The requeue worker owns these.
 */
export function isLivenessFailureTask(task: Pick<TaskState, 'execution'>): boolean {
  return isLivenessFailureClass(task.execution.failureClass);
}
