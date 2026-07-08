import type { TaskState } from '@invoker/workflow-core';

export interface ForcedStopTaskStore {
  loadTask(taskId: string): TaskState | undefined;
}

export function isTaskInFlightForForcedStop(task: TaskState): boolean {
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || (task.status === 'pending' && task.execution.phase === 'launching');
}

export function resolveTaskForForcedStop(
  task: TaskState,
  store?: ForcedStopTaskStore | null,
): TaskState | undefined {
  let latest = task;
  if (store) {
    try {
      const persisted = store.loadTask(task.id);
      if (!persisted) return undefined;
      latest = persisted;
    } catch {
      latest = task;
    }
  }

  return isTaskInFlightForForcedStop(latest) ? latest : undefined;
}
