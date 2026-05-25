/**
 * Failed-task delta handler that routes failures to the external
 * recovery launcher instead of scheduling an in-process AI fix.
 *
 * Both GUI owner mode (main.ts) and generic headless execution paths
 * (headless.ts) call this handler on every TASK_DELTA. Non-failed
 * deltas, cancellation failures, and deltas whose task has no resolvable
 * workflowId short-circuit before touching the launcher.
 */

import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
import type { InvokerConfig } from './config.js';
import {
  type ExternalFailureRecoveryContext,
  type ExternalFailureRecoveryLauncher,
  type LaunchResult,
} from './external-failure-recovery.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';

export type FailedDeltaSkipReason =
  | 'not-failed-delta'
  | 'cancellation'
  | 'no-workflow-id';

export type FailedDeltaRecoveryOutcome =
  | LaunchResult
  | { launched: false; reason: FailedDeltaSkipReason };

export interface FailedDeltaExternalRecoveryDeps {
  orchestrator: Pick<Orchestrator, 'getTask'>;
  persistence: Pick<SQLiteAdapter, 'logEvent'>;
  invokerConfig: InvokerConfig;
  repoRoot: string;
  dbDir: string;
  launcher: ExternalFailureRecoveryLauncher;
  logger?: Pick<Logger, 'info'>;
  logSource?: string;
}

export function handleFailedDeltaForExternalRecovery(
  delta: TaskDelta,
  deps: FailedDeltaExternalRecoveryDeps,
): FailedDeltaRecoveryOutcome {
  if (delta.type !== 'updated' || delta.changes.status !== 'failed') {
    return { launched: false, reason: 'not-failed-delta' };
  }

  const taskId = delta.taskId;
  if (shouldSkipAutoFixForError(delta.changes.execution?.error)) {
    logExternalRecoveryDebug(taskId, 'skip-cancellation', deps);
    return { launched: false, reason: 'cancellation' };
  }

  const task = deps.orchestrator.getTask(taskId) as TaskState | undefined;
  const workflowId = task?.config.workflowId;
  if (!workflowId) {
    logExternalRecoveryDebug(taskId, 'skip-no-workflow', deps);
    return { launched: false, reason: 'no-workflow-id' };
  }

  const context: ExternalFailureRecoveryContext = {
    failedTaskId: taskId,
    failedWorkflowId: workflowId,
    repoRoot: deps.repoRoot,
    dbDir: deps.dbDir,
  };
  const result = deps.launcher.launch(deps.invokerConfig, context);
  logExternalRecoveryDebug(taskId, 'launch-result', deps, {
    workflowId,
    result,
  });
  return result;
}

function logExternalRecoveryDebug(
  taskId: string,
  phase: string,
  deps: FailedDeltaExternalRecoveryDeps,
  details: Record<string, unknown> = {},
): void {
  const payload = { phase, ...details };
  deps.persistence.logEvent?.(taskId, 'debug.external-recovery', payload);
  deps.logger?.info?.(
    `[external-recovery]${deps.logSource ? `[${deps.logSource}]` : ''} task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}`,
    { module: 'external-recovery' },
  );
}
