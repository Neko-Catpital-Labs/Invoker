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
  options?: { wasExplicitRetry?: boolean },
): boolean {
  if (delta.type !== 'updated' || delta.changes.status !== 'failed') {
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
  if (options?.wasExplicitRetry) {
    return true;
  }
  const previousStatus = parseSnapshotStatus(previousSnapshot);
  return previousStatus === 'running' || previousStatus === 'fixing_with_ai';
}
