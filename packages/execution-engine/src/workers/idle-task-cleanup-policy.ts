import type { TaskStatus, WorkflowDerivedStatus } from '@invoker/workflow-core';

export const IDLE_WORKFLOW_RETENTION_MS = 48 * 60 * 60_000;

const INACTIVE_CLEANUP_TASK_STATUSES = [
  'completed',
  'failed',
  'closed',
  'stale',
] as const satisfies readonly TaskStatus[];

const KNOWN_CLEANUP_WORKFLOW_STATUSES = [
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

const INACTIVE_CLEANUP_TASK_STATUS_SET = new Set<string>(INACTIVE_CLEANUP_TASK_STATUSES);
const KNOWN_CLEANUP_WORKFLOW_STATUS_SET = new Set<string>(KNOWN_CLEANUP_WORKFLOW_STATUSES);

/**
 * Cleanup treats only terminal task states as inactive. Every live, waiting,
 * blocked, or unknown state is retained so new states fail closed.
 */
export function isInactiveCleanupTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && INACTIVE_CLEANUP_TASK_STATUS_SET.has(status);
}

/** Unknown workflow states are retained until cleanup policy handles them explicitly. */
export function isKnownCleanupWorkflowStatus(status: unknown): status is WorkflowDerivedStatus {
  return typeof status === 'string' && KNOWN_CLEANUP_WORKFLOW_STATUS_SET.has(status);
}

/**
 * `updatedAt` is the workflow's canonical activity timestamp: the orchestrator
 * touches it on task status changes. The boundary is deliberately strict;
 * exactly 48 hours old is retained.
 */
export function isWorkflowPastRetention(
  updatedAt: string | undefined,
  now: number,
  retentionMs: number = IDLE_WORKFLOW_RETENTION_MS,
): boolean {
  if (updatedAt === undefined || !Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    return false;
  }
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && now - updatedAtMs > retentionMs;
}
