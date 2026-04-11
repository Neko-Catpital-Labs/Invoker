/**
 * Extracted delta-merge logic for `lastKnownTaskStates`.
 *
 * Applies a TaskDelta to the snapshot map, falling back to the
 * orchestrator when an `updated` delta arrives for an unknown task
 * (out-of-order delta — the `created` delta was missed).
 */
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

export interface TaskLookup {
  getAllTasks(): TaskState[];
}

/**
 * Apply a single TaskDelta to the lastKnownTaskStates map.
 *
 * @param delta       The incoming delta.
 * @param stateMap    Map of taskId → JSON-serialized TaskState snapshots.
 * @param taskLookup  Optional fallback to seed unknown tasks (e.g. orchestrator).
 */
export function applyDelta(
  delta: TaskDelta,
  stateMap: Map<string, string>,
  taskLookup?: TaskLookup,
): void {
  if (delta.type === 'created') {
    stateMap.set(delta.task.id, JSON.stringify(delta.task));
  } else if (delta.type === 'updated') {
    let existing = stateMap.get(delta.taskId);
    if (!existing && taskLookup) {
      const task = taskLookup.getAllTasks().find(t => t.id === delta.taskId);
      if (task) {
        existing = JSON.stringify(task);
        stateMap.set(delta.taskId, existing);
      }
    }
    if (existing) {
      const prev = JSON.parse(existing);
      const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
      const task = {
        ...prev,
        ...topLevel,
        config: { ...prev.config, ...cfgChanges },
        execution: { ...prev.execution, ...execChanges },
      };
      stateMap.set(delta.taskId, JSON.stringify(task));
    }
  } else if (delta.type === 'removed') {
    stateMap.delete(delta.taskId);
  }
}
