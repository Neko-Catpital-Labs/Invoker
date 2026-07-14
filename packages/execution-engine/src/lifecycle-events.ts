/**
 * Shared lifecycle event type vocabulary.
 *
 * These are the pure type/shape definitions the auto-fix recovery engine needs
 * to subscribe to workflow lifecycle wakeups without importing `@invoker/app`.
 * The app's `lifecycle-events.ts` re-exports them and keeps the event *builders*
 * and runtime type guards, which remain app-side bridge concerns.
 */

import type { TaskStatus, WorkflowDerivedStatus } from '@invoker/workflow-core';

export const WORKFLOW_LIFECYCLE_EVENT_KINDS = [
  'task.created',
  'task.updated',
  'task.completed',
  'task.failed',
  'task.review_ready',
  'task.awaiting_approval',
  'task.needs_input',
  'task.removed',
  'review_gate.ci_failed',
  'review_gate.merge_conflict',
  'workflow.wakeup',
] as const;

export type WorkflowLifecycleEventKind = typeof WORKFLOW_LIFECYCLE_EVENT_KINDS[number];
export type WorkflowLifecycleStatus = TaskStatus | WorkflowDerivedStatus;

export interface WorkflowLifecycleEventBase {
  readonly eventKey: string;
  readonly kind: WorkflowLifecycleEventKind;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly status?: WorkflowLifecycleStatus;
  readonly previousStatus?: TaskStatus;
  readonly taskStateVersion?: number;
  readonly generation: number;
  readonly attemptId?: string;
  readonly createdAt: string;
  readonly recoveryWakeup: RecoveryWorkerWakeupHint;
}

export interface RecoveryWorkerWakeupHint {
  readonly eventKey: string;
  readonly eventKind: WorkflowLifecycleEventKind;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly taskStateVersion?: number;
  readonly generation: number;
  readonly attemptId?: string;
  readonly createdAt: string;
  readonly reason: RecoveryWorkerWakeupReason;
  readonly authoritative: false;
}

export type RecoveryWorkerWakeupReason =
  | 'task_lifecycle'
  | 'task_failure'
  | 'review_gate_failure'
  | 'workflow_reconcile';

export interface TaskLifecycleEvent extends WorkflowLifecycleEventBase {
  readonly kind:
    | 'task.created'
    | 'task.updated'
    | 'task.completed'
    | 'task.failed'
    | 'task.review_ready'
    | 'task.awaiting_approval'
    | 'task.needs_input'
    | 'task.removed';
  readonly taskId: string;
  readonly status?: TaskStatus;
}

export interface ReviewGateFailedCheck {
  readonly name: string;
  readonly conclusion?: string;
  readonly detailsUrl?: string;
}

export interface ReviewGateCiFailedLifecycleEvent extends WorkflowLifecycleEventBase {
  readonly kind: 'review_gate.ci_failed';
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly failedChecks: readonly ReviewGateFailedCheck[];
  readonly statusText: string;
}

export interface ReviewGateMergeConflictLifecycleEvent extends WorkflowLifecycleEventBase {
  readonly kind: 'review_gate.merge_conflict';
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly statusText: string;
}

export interface WorkflowWakeupLifecycleEvent extends WorkflowLifecycleEventBase {
  readonly kind: 'workflow.wakeup';
  readonly reason: WorkflowWakeupReason;
  readonly status?: WorkflowDerivedStatus;
}

export type WorkflowLifecycleEvent =
  | TaskLifecycleEvent
  | ReviewGateCiFailedLifecycleEvent
  | ReviewGateMergeConflictLifecycleEvent
  | WorkflowWakeupLifecycleEvent;

export type WorkflowWakeupReason =
  | 'startup_reconcile'
  | 'stalled_workflow_recovery'
  | 'external_dependency_reconcile'
  | 'manual_reconcile';
