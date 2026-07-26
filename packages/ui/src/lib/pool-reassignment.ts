import type { TaskState } from '../types.js';

export interface PoolReassignmentSummary {
  readonly loadedTaskCount: number;
  readonly matchedTaskIds: readonly string[];
  readonly skippedMergeCount: number;
  readonly skippedAlreadyTargetedCount: number;
  readonly skippedNonSourceCount: number;
  readonly skippedCount: number;
}

export interface PoolReassignmentFailure {
  readonly taskId: string;
  readonly error: string;
}

export interface PoolReassignmentResult extends PoolReassignmentSummary {
  readonly sourcePoolId: string;
  readonly destinationPoolId: string;
  readonly successCount: number;
  readonly failedCount: number;
  readonly failures: readonly PoolReassignmentFailure[];
}

export function summarizePoolReassignment(
  tasks: Iterable<TaskState>,
  sourcePoolId: string,
  destinationPoolId: string,
): PoolReassignmentSummary {
  const matchedTaskIds: string[] = [];
  let loadedTaskCount = 0;
  let skippedMergeCount = 0;
  let skippedAlreadyTargetedCount = 0;
  let skippedNonSourceCount = 0;

  for (const task of tasks) {
    loadedTaskCount += 1;
    if (task.config.isMergeNode) {
      skippedMergeCount += 1;
      continue;
    }
    if (task.config.poolId === destinationPoolId) {
      skippedAlreadyTargetedCount += 1;
      continue;
    }
    if (task.config.poolId === sourcePoolId) {
      matchedTaskIds.push(task.id);
      continue;
    }
    skippedNonSourceCount += 1;
  }

  return {
    loadedTaskCount,
    matchedTaskIds,
    skippedMergeCount,
    skippedAlreadyTargetedCount,
    skippedNonSourceCount,
    skippedCount: skippedMergeCount + skippedAlreadyTargetedCount + skippedNonSourceCount,
  };
}
