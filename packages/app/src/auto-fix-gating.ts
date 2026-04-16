import type { TaskDelta, TaskState } from '@invoker/workflow-core';

type TaskStatus = TaskState['status'];

function parseSnapshotStatus(snapshot?: string): TaskStatus | undefined {
  if (!snapshot) return undefined;
  try {
    const parsed = JSON.parse(snapshot) as { status?: TaskStatus };
    return parsed.status;
  } catch {
    return undefined;
  }
}

export function shouldAutoFixFromDelta(
  delta: TaskDelta,
  previousSnapshot?: string,
  options?: { suppressedTaskIds?: ReadonlySet<string> },
): boolean {
  if (delta.type !== 'updated' || delta.changes.status !== 'failed') {
    return false;
  }
  if (options?.suppressedTaskIds?.has(delta.taskId)) {
    return false;
  }
  const errorText = delta.changes.execution?.error;
  if (typeof errorText === 'string') {
    if (
      errorText.startsWith('Cancelled by user')
      || errorText.startsWith('Cancelled:')
    ) {
      return false;
    }
  }
  const previousStatus = parseSnapshotStatus(previousSnapshot);
  return previousStatus === 'running' || previousStatus === 'fixing_with_ai';
}
