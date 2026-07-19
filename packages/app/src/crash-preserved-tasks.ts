import type { PersistenceAdapter } from '@invoker/data-store';
import { isCrashPreservedExecution, type TaskState } from '@invoker/workflow-core';
import {
  formatPreviousOwnerCrashDiagnostic,
  type ReclaimedDeadOwnerInfo,
} from './db-writer-lock.js';

export function isTaskInFlightForCrashPreservation(task: TaskState): boolean {
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || ((task.status === 'pending' || (task.status as string) === 'queued') && task.execution.phase === 'launching');
}

export function buildCrashPreservationSummary(reclaimedDeadOwner: ReclaimedDeadOwnerInfo): string {
  if (reclaimedDeadOwner.diagnostic) {
    return formatPreviousOwnerCrashDiagnostic(reclaimedDeadOwner.diagnostic);
  }
  return `previous owner pid=${reclaimedDeadOwner.pid}; no matching crash report found`;
}

export function preserveCrashedInFlightTasks(
  persistence: PersistenceAdapter,
  tasks: readonly TaskState[],
  reclaimedDeadOwner: ReclaimedDeadOwnerInfo,
  preservedAt: Date,
): string[] {
  const preservedTaskIds: string[] = [];
  const diagnosticSummary = buildCrashPreservationSummary(reclaimedDeadOwner);
  for (const task of tasks) {
    if (!isTaskInFlightForCrashPreservation(task)) continue;
    if (isCrashPreservedExecution(task.execution)) continue;
    persistence.updateTask(task.id, {
      execution: {
        crashPreservedAt: preservedAt,
        crashPreservedOwnerPid: reclaimedDeadOwner.pid,
        crashPreservedReportPath: reclaimedDeadOwner.diagnostic?.reportPath,
        crashPreservedDiagnosticSummary: diagnosticSummary,
      },
    });
    persistence.logEvent?.(task.id, 'task.crash_preserved', {
      preservedAt: preservedAt.toISOString(),
      previousOwnerPid: reclaimedDeadOwner.pid,
      diagnosticReportPath: reclaimedDeadOwner.diagnostic?.reportPath ?? null,
      diagnosticSummary,
    });
    preservedTaskIds.push(task.id);
  }
  return preservedTaskIds;
}
