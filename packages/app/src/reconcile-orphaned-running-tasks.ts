import { isCrashPreservedExecution, type TaskState } from '@invoker/workflow-core';

import {
  persistShutdownDiagnostic,
  type ShutdownDiagnosticDb,
} from './shutdown-diagnostic.js';

export function isTaskInFlightForForcedStop(task: TaskState): boolean {
  if (isCrashPreservedExecution(task.execution)) return false;
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || ((task.status === 'pending' || task.status === 'queued') && task.execution.phase === 'launching');
}

type BootReconcileOrchestrator = {
  getAllTasks(): TaskState[];
  handleWorkerResponse(response: {
    requestId: string;
    actionId: string;
    attemptId?: string;
    executionGeneration: number;
    status: 'failed';
    outputs: { exitCode: number; error: string };
  }): unknown;
};

export type ReconcileOrphanedInFlightTasksOptions = {
  orchestrator: BootReconcileOrchestrator;
  persistence?: ShutdownDiagnosticDb | null;
  reason?: string;
};

/**
 * Fail durable in-flight tasks left behind when a previous owner died without
 * before-quit cleanup (SIGKILL / crash). Mirrors graceful Application quit.
 */
export function reconcileOrphanedInFlightTasksOnBoot(
  options: ReconcileOrphanedInFlightTasksOptions,
): TaskState[] {
  const reason = options.reason ?? 'Application quit';
  const failed: TaskState[] = [];

  for (const task of options.orchestrator.getAllTasks()) {
    if (!isTaskInFlightForForcedStop(task)) continue;

    if (options.persistence) {
      persistShutdownDiagnostic(task, options.persistence, {
        forcedStopReason: reason,
        label: 'Startup Orphan Diagnostic',
      });
    }

    options.orchestrator.handleWorkerResponse({
      requestId: `boot-orphan-${task.id}`,
      actionId: task.id,
      attemptId: task.execution.selectedAttemptId,
      executionGeneration: task.execution.generation ?? 0,
      status: 'failed',
      outputs: { exitCode: 1, error: reason },
    });
    failed.push(task);
  }

  return failed;
}
