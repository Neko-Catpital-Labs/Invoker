import type { TaskState } from '@invoker/workflow-core';

export interface DeferredRunnableSelection {
  runnable: TaskState[];
  dropped: TaskState[];
}

export interface DeferredLaunchTimingInput {
  existingFirstScheduledAtMs?: number;
  nowMs: number;
  deferDelayMs: number;
  maxCoalesceMs?: number;
}

export interface DeferredLaunchTiming {
  firstScheduledAtMs: number;
  delayMs: number;
}

/**
 * Select runnable tasks for deferred no-track launch.
 * Current behavior scopes to workflowId when provided.
 */
export function selectDeferredRunnableTasks(
  tasks: TaskState[],
  workflowId?: string,
): DeferredRunnableSelection {
  const runnable = workflowId
    ? tasks.filter((task) => task.config.workflowId === workflowId)
    : tasks;
  const dropped = workflowId
    ? tasks.filter((task) => task.config.workflowId !== workflowId)
    : [];
  return { runnable, dropped };
}

/**
 * Compute deferred launch timing when coalescing repeated no-track retries.
 * Prevent unbounded deferral by capping total coalesce window.
 */
export function computeDeferredLaunchTiming(input: DeferredLaunchTimingInput): DeferredLaunchTiming {
  const firstScheduledAtMs = input.existingFirstScheduledAtMs ?? input.nowMs;
  const maxCoalesceMs = input.maxCoalesceMs ?? input.deferDelayMs;
  const elapsedMs = Math.max(0, input.nowMs - firstScheduledAtMs);
  const remainingMs = Math.max(0, maxCoalesceMs - elapsedMs);
  const delayMs = Math.min(input.deferDelayMs, remainingMs);
  return {
    firstScheduledAtMs,
    delayMs,
  };
}
