import type { TaskState } from '@invoker/workflow-core';
import type { TaskSnapshotCache } from './delta-merge.js';
import type { WorkflowRollupProjection } from './workflow-rollup-projection.js';

export interface ViewerTaskCaches {
  lastKnownTaskStates: TaskSnapshotCache;
  workflowRollupProjection: WorkflowRollupProjection;
}

/**
 * Replace the main-process delta caches with an authoritative task list.
 *
 * Shared by the owner's local seeding (`seedUiSnapshotCache`,
 * `publishOrchestratorSnapshotToRenderer`) and by the detached viewer, which
 * seeds from the owner's delegated snapshot. Seeding the cache is what gives
 * incoming `updated` deltas a base entry; without it every delta for a task the
 * viewer has not seen is quarantined and effectively dropped.
 */
export function seedTaskCachesFromSnapshot(tasks: readonly TaskState[], caches: ViewerTaskCaches): void {
  caches.lastKnownTaskStates.clear();
  caches.workflowRollupProjection.replaceAll(tasks);
  for (const task of tasks) {
    caches.lastKnownTaskStates.set(task.id, JSON.stringify(task));
  }
}
