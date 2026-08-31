import {
  TASK_STATUSES,
  type TaskStatus,
  type WorkflowDerivedStatus,
} from '@invoker/workflow-core';

export const WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS = 48 * 60 * 60_000;

const KNOWN_TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

/**
 * These outcomes contain no work that can still advance, so they permit
 * immediate retirement of a completed workflow. Every other known task status
 * blocks that path. Unknown statuses fail closed automatically.
 */
const INACTIVE_TASK_STATUS_SET: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'closed',
  'stale',
]);

const EXECUTING_TASK_STATUS_SET: ReadonlySet<TaskStatus> = new Set([
  'running',
  'fixing_with_ai',
]);

const KNOWN_WORKFLOW_STATUSES = [
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'closed',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
] as const satisfies readonly WorkflowDerivedStatus[];

const KNOWN_WORKFLOW_STATUS_SET: ReadonlySet<string> = new Set(KNOWN_WORKFLOW_STATUSES);

export interface WorkflowRetirementCandidate {
  readonly status?: string;
  readonly updatedAt?: string | Date;
}

export interface WorkflowRetirementTask {
  readonly status?: string;
}

export type WorkflowRetirementDecision =
  | { readonly kind: 'retain' }
  | {
      readonly kind: 'retire';
      readonly reason: 'completed' | 'inactive-over-threshold';
    };

function isKnownTaskStatus(status: string | undefined): status is TaskStatus {
  return status !== undefined && KNOWN_TASK_STATUS_SET.has(status);
}

function isKnownWorkflowStatus(status: string | undefined): status is WorkflowDerivedStatus {
  return status !== undefined && KNOWN_WORKFLOW_STATUS_SET.has(status);
}

export function hasActiveOrUnknownTask(tasks: readonly WorkflowRetirementTask[]): boolean {
  return tasks.some((task) =>
    !isKnownTaskStatus(task.status) || !INACTIVE_TASK_STATUS_SET.has(task.status),
  );
}

function hasExecutingOrUnknownTask(tasks: readonly WorkflowRetirementTask[]): boolean {
  return tasks.some((task) =>
    !isKnownTaskStatus(task.status) || EXECUTING_TASK_STATUS_SET.has(task.status),
  );
}

/**
 * Completed workflows retire immediately once all tasks are inactive. Other
 * known workflow states retire only when their last update is strictly older
 * than the threshold and no task is executing. Unknown states and malformed
 * timestamps are retained.
 */
export function decideWorkflowRetirement(
  workflow: WorkflowRetirementCandidate,
  tasks: readonly WorkflowRetirementTask[],
  options: {
    readonly now: number;
    readonly idleThresholdMs?: number;
  },
): WorkflowRetirementDecision {
  if (!isKnownWorkflowStatus(workflow.status)) return { kind: 'retain' };

  if (workflow.status === 'completed') {
    if (hasActiveOrUnknownTask(tasks)) return { kind: 'retain' };
    return { kind: 'retire', reason: 'completed' };
  }

  if (hasExecutingOrUnknownTask(tasks)) return { kind: 'retain' };

  const updatedAtMs = workflow.updatedAt instanceof Date
    ? workflow.updatedAt.getTime()
    : Date.parse(workflow.updatedAt ?? '');
  if (!Number.isFinite(updatedAtMs)) return { kind: 'retain' };

  const idleThresholdMs = options.idleThresholdMs ?? WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS;
  if (options.now - updatedAtMs <= idleThresholdMs) return { kind: 'retain' };

  return { kind: 'retire', reason: 'inactive-over-threshold' };
}
