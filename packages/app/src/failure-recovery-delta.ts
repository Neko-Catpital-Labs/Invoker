/**
 * Shared dispatch helper for routing failed `TaskDelta`s to the
 * external failure recovery launcher.
 *
 * Both the GUI owner (`main.ts`) and headless command runners
 * (`headless.ts`) observe the same TASK_DELTA stream. Each used to
 * schedule an automatic `invoker:fix-with-agent` mutation when a task
 * failed; this helper replaces that behaviour with a single fire-and-
 * forget hand-off to the operator-configured recovery process.
 *
 * The helper is pure with respect to its inputs so the policy
 * (cancellation skips, missing workflow ids, launcher cooldown) can be
 * exercised in isolation by tests.
 */

import type { TaskDelta } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import type {
  ExternalFailureRecoveryLauncher,
  ExternalFailureRecoveryResult,
} from './external-failure-recovery.js';

export const FAILURE_RECOVERY_EVENT = 'debug.external-recovery';

export interface FailureRecoveryContext {
  repoRoot: string;
  dbDir: string;
  workflowIdForTask: (taskId: string) => string | undefined;
}

export interface FailureRecoveryDeps {
  persistence: Pick<SQLiteAdapter, 'logEvent'>;
  launcher: ExternalFailureRecoveryLauncher;
  context: FailureRecoveryContext;
}

export type FailureRecoveryOutcome =
  | { handled: false; reason: 'not-failed-delta' | 'cancellation' | 'workflow-not-found' }
  | { handled: true; result: ExternalFailureRecoveryResult };

/**
 * Inspect a single TaskDelta and, when it represents a task failure that
 * is eligible for external recovery, invoke the launcher. Returns an
 * outcome describing what happened so callers can attach extra logging.
 */
export function handleFailedTaskDelta(
  delta: TaskDelta,
  deps: FailureRecoveryDeps,
): FailureRecoveryOutcome {
  if (delta.type !== 'updated' || delta.changes.status !== 'failed') {
    return { handled: false, reason: 'not-failed-delta' };
  }
  const failedTaskId = delta.taskId;
  if (shouldSkipAutoFixForError(delta.changes.execution?.error)) {
    deps.persistence.logEvent?.(failedTaskId, FAILURE_RECOVERY_EVENT, {
      phase: 'skip',
      reason: 'cancellation',
    });
    return { handled: false, reason: 'cancellation' };
  }
  const failedWorkflowId = deps.context.workflowIdForTask(failedTaskId);
  if (!failedWorkflowId) {
    deps.persistence.logEvent?.(failedTaskId, FAILURE_RECOVERY_EVENT, {
      phase: 'skip',
      reason: 'workflow-not-found',
    });
    return { handled: false, reason: 'workflow-not-found' };
  }
  deps.persistence.logEvent?.(failedTaskId, FAILURE_RECOVERY_EVENT, {
    phase: 'delta-failed',
    failedWorkflowId,
  });
  const result = deps.launcher.trigger({
    failedTaskId,
    failedWorkflowId,
    repoRoot: deps.context.repoRoot,
    dbDir: deps.context.dbDir,
  });
  deps.persistence.logEvent?.(failedTaskId, FAILURE_RECOVERY_EVENT, {
    phase: result.launched ? 'launched' : 'skipped',
    failedWorkflowId,
    ...(result.launched ? {} : { reason: result.reason }),
  });
  return { handled: true, result };
}
