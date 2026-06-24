import type {
  TaskDelta,
  TaskState,
  TaskStatus,
  WorkflowDerivedStatus,
} from '@invoker/workflow-core';
import {
  WORKFLOW_LIFECYCLE_EVENT_KINDS,
  type WorkflowLifecycleEvent,
  type WorkflowLifecycleEventKind,
  type WorkflowLifecycleStatus,
  type TaskLifecycleEvent,
  type ReviewGateFailedCheck,
  type ReviewGateCiFailedLifecycleEvent,
  type WorkflowWakeupLifecycleEvent,
  type RecoveryWorkerWakeupHint,
  type RecoveryWorkerWakeupReason,
  type WorkflowWakeupReason,
} from '@invoker/execution-engine';

// The lifecycle event type vocabulary moved into `@invoker/execution-engine`
// so the auto-fix recovery engine can consume it without importing the app.
// Re-export it here so existing `./lifecycle-events.js` importers are unchanged.
export {
  WORKFLOW_LIFECYCLE_EVENT_KINDS,
  type WorkflowLifecycleEvent,
  type WorkflowLifecycleEventKind,
  type WorkflowLifecycleStatus,
  type WorkflowLifecycleEventBase,
  type TaskLifecycleEvent,
  type ReviewGateFailedCheck,
  type ReviewGateCiFailedLifecycleEvent,
  type WorkflowWakeupLifecycleEvent,
  type RecoveryWorkerWakeupHint,
  type RecoveryWorkerWakeupReason,
  type WorkflowWakeupReason,
} from '@invoker/execution-engine';

export interface LifecycleBuildOptions {
  readonly workflowId?: string;
  readonly previousStatus?: TaskStatus;
  readonly generation?: number;
  readonly attemptId?: string;
  readonly createdAt?: Date;
}

export interface TaskUpdatedLifecycleEventInput extends LifecycleBuildOptions {
  readonly workflowId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly taskStateVersion: number;
}

export interface TaskRemovedLifecycleEventInput extends LifecycleBuildOptions {
  readonly workflowId: string;
  readonly taskId: string;
  readonly status?: TaskStatus;
  readonly taskStateVersion: number;
}

export interface ReviewGateCiFailedLifecycleEventInput extends LifecycleBuildOptions {
  readonly workflowId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly taskStateVersion: number;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly failedChecks: readonly ReviewGateFailedCheck[];
  readonly statusText: string;
}

export interface WorkflowWakeupLifecycleEventInput {
  readonly workflowId: string;
  readonly status?: WorkflowDerivedStatus;
  readonly generation?: number;
  readonly reason: WorkflowWakeupReason;
  readonly createdAt?: Date;
}

const STATUS_VALUES: readonly WorkflowLifecycleStatus[] = [
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'closed',
  'needs_input',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
];

const EVENT_KIND_SET = new Set<string>(WORKFLOW_LIFECYCLE_EVENT_KINDS);
const STATUS_SET = new Set<string>(STATUS_VALUES);

export function lifecycleEventKindForTaskStatus(status: TaskStatus): TaskLifecycleEvent['kind'] {
  switch (status) {
    case 'completed':
      return 'task.completed';
    case 'failed':
      return 'task.failed';
    case 'review_ready':
      return 'task.review_ready';
    case 'awaiting_approval':
      return 'task.awaiting_approval';
    case 'needs_input':
      return 'task.needs_input';
    default:
      return 'task.updated';
  }
}

export function buildLifecycleEventKey(input: {
  readonly kind: WorkflowLifecycleEventKind;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly taskStateVersion?: number;
  readonly generation?: number;
  readonly attemptId?: string;
  readonly discriminator?: string;
}): string {
  return [
    input.kind,
    `workflow:${input.workflowId}`,
    input.taskId ? `task:${input.taskId}` : undefined,
    `generation:${input.generation ?? 0}`,
    input.attemptId ? `attempt:${input.attemptId}` : undefined,
    input.taskStateVersion != null ? `task-state:${input.taskStateVersion}` : undefined,
    input.discriminator,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('|');
}

export function buildTaskCreatedLifecycleEvent(
  task: TaskState,
  options: LifecycleBuildOptions = {},
): TaskLifecycleEvent {
  const workflowId = requireWorkflowId(options.workflowId ?? task.config.workflowId, task.id);
  const generation = options.generation ?? task.execution.generation ?? 0;
  const attemptId = options.attemptId ?? task.execution.selectedAttemptId;
  return buildTaskLifecycleEvent({
    kind: 'task.created',
    workflowId,
    taskId: task.id,
    status: task.status,
    taskStateVersion: task.taskStateVersion,
    generation,
    attemptId,
    createdAt: options.createdAt,
  });
}

export function buildTaskUpdatedLifecycleEvent(input: TaskUpdatedLifecycleEventInput): TaskLifecycleEvent {
  return buildTaskLifecycleEvent({
    kind: lifecycleEventKindForTaskStatus(input.status),
    workflowId: input.workflowId,
    taskId: input.taskId,
    status: input.status,
    previousStatus: input.previousStatus,
    taskStateVersion: input.taskStateVersion,
    generation: input.generation ?? 0,
    attemptId: input.attemptId,
    createdAt: input.createdAt,
  });
}

export function buildTaskRemovedLifecycleEvent(input: TaskRemovedLifecycleEventInput): TaskLifecycleEvent {
  return buildTaskLifecycleEvent({
    kind: 'task.removed',
    workflowId: input.workflowId,
    taskId: input.taskId,
    status: input.status,
    previousStatus: input.previousStatus,
    taskStateVersion: input.taskStateVersion,
    generation: input.generation ?? 0,
    attemptId: input.attemptId,
    createdAt: input.createdAt,
  });
}

export function buildReviewGateCiFailedLifecycleEvent(
  input: ReviewGateCiFailedLifecycleEventInput,
): ReviewGateCiFailedLifecycleEvent {
  const generation = input.generation ?? 0;
  const createdAt = lifecycleCreatedAt(input.createdAt);
  const eventKey = buildLifecycleEventKey({
    kind: 'review_gate.ci_failed',
    workflowId: input.workflowId,
    taskId: input.taskId,
    taskStateVersion: input.taskStateVersion,
    generation,
    attemptId: input.attemptId,
    discriminator: `review:${input.reviewId}:${input.headSha ?? 'no-head-sha'}`,
  });

  return {
    eventKey,
    kind: 'review_gate.ci_failed',
    workflowId: input.workflowId,
    taskId: input.taskId,
    status: input.status,
    taskStateVersion: input.taskStateVersion,
    generation,
    ...(input.previousStatus ? { previousStatus: input.previousStatus } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    createdAt,
    recoveryWakeup: buildRecoveryWorkerWakeupHint({
      eventKey,
      eventKind: 'review_gate.ci_failed',
      workflowId: input.workflowId,
      taskId: input.taskId,
      taskStateVersion: input.taskStateVersion,
      generation,
      attemptId: input.attemptId,
      createdAt,
      reason: 'review_gate_failure',
    }),
    reviewId: input.reviewId,
    reviewUrl: input.reviewUrl,
    ...(input.headSha ? { headSha: input.headSha } : {}),
    ...(input.headRef ? { headRef: input.headRef } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    failedChecks: input.failedChecks.map((check) => ({ ...check })),
    statusText: input.statusText,
  };
}

export function buildWorkflowWakeupLifecycleEvent(
  input: WorkflowWakeupLifecycleEventInput,
): WorkflowWakeupLifecycleEvent {
  const generation = input.generation ?? 0;
  const createdAt = lifecycleCreatedAt(input.createdAt);
  const eventKey = buildLifecycleEventKey({
    kind: 'workflow.wakeup',
    workflowId: input.workflowId,
    generation,
    discriminator: `reason:${input.reason}`,
  });
  return {
    eventKey,
    kind: 'workflow.wakeup',
    workflowId: input.workflowId,
    ...(input.status ? { status: input.status } : {}),
    generation,
    createdAt,
    recoveryWakeup: buildRecoveryWorkerWakeupHint({
      eventKey,
      eventKind: 'workflow.wakeup',
      workflowId: input.workflowId,
      generation,
      createdAt,
      reason: 'workflow_reconcile',
    }),
    reason: input.reason,
  };
}

export function buildLifecycleEventFromTaskDelta(
  delta: TaskDelta,
  options: LifecycleBuildOptions = {},
): TaskLifecycleEvent {
  switch (delta.type) {
    case 'created':
      return buildTaskCreatedLifecycleEvent(delta.task, options);
    case 'updated': {
      const status = delta.changes.status ?? options.previousStatus;
      return buildTaskUpdatedLifecycleEvent({
        workflowId: requireWorkflowId(options.workflowId, delta.taskId),
        taskId: delta.taskId,
        status: requireTaskStatus(status, delta.taskId),
        previousStatus: options.previousStatus,
        taskStateVersion: delta.taskStateVersion,
        generation: options.generation ?? delta.changes.execution?.generation,
        attemptId: options.attemptId ?? delta.changes.execution?.selectedAttemptId,
        createdAt: options.createdAt,
      });
    }
    case 'removed':
      return buildTaskRemovedLifecycleEvent({
        workflowId: requireWorkflowId(options.workflowId, delta.taskId),
        taskId: delta.taskId,
        status: undefined,
        previousStatus: options.previousStatus,
        taskStateVersion: delta.previousTaskStateVersion,
        generation: options.generation,
        attemptId: options.attemptId,
        createdAt: options.createdAt,
      });
  }
}

export function isWorkflowLifecycleEventKind(value: unknown): value is WorkflowLifecycleEventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value);
}

export function isWorkflowLifecycleEvent(value: unknown): value is WorkflowLifecycleEvent {
  if (!isRecord(value)) return false;
  if (typeof value.eventKey !== 'string') return false;
  if (!isWorkflowLifecycleEventKind(value.kind)) return false;
  if (typeof value.workflowId !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (!isCanonicalUtcIsoTimestamp(value.createdAt)) return false;
  if (typeof value.generation !== 'number') return false;
  if (value.taskId != null && typeof value.taskId !== 'string') return false;
  if (value.status != null && !isWorkflowLifecycleStatus(value.status)) return false;
  if (value.previousStatus != null && !isTaskStatus(value.previousStatus)) return false;
  if (value.taskStateVersion != null && typeof value.taskStateVersion !== 'number') return false;
  if (value.attemptId != null && typeof value.attemptId !== 'string') return false;
  if (!isRecoveryWorkerWakeupHint(value.recoveryWakeup, value)) return false;

  switch (value.kind) {
    case 'task.created':
    case 'task.updated':
    case 'task.completed':
    case 'task.failed':
    case 'task.review_ready':
    case 'task.awaiting_approval':
    case 'task.needs_input':
    case 'task.removed':
      return typeof value.taskId === 'string';
    case 'review_gate.ci_failed':
      return typeof value.taskId === 'string'
        && typeof value.status === 'string'
        && typeof value.reviewId === 'string'
        && typeof value.reviewUrl === 'string'
        && Array.isArray(value.failedChecks)
        && typeof value.statusText === 'string';
    case 'workflow.wakeup':
      return value.reason === 'startup_reconcile'
        || value.reason === 'stalled_workflow_recovery'
        || value.reason === 'external_dependency_reconcile'
        || value.reason === 'manual_reconcile';
  }
}

export function isTaskLifecycleEvent(value: unknown): value is TaskLifecycleEvent {
  return isWorkflowLifecycleEvent(value) && value.kind.startsWith('task.');
}

export function lifecycleEventMatchesPersistedTask(
  event: WorkflowLifecycleEvent,
  task: TaskState | undefined,
): boolean {
  if (!event.taskId || !task) return false;
  if (event.workflowId !== task.config.workflowId) return false;
  if (event.taskId !== task.id) return false;
  if (event.taskStateVersion !== task.taskStateVersion) return false;
  if (event.generation !== (task.execution.generation ?? 0)) return false;
  if (event.attemptId !== task.execution.selectedAttemptId) return false;
  return true;
}

function buildTaskLifecycleEvent(input: {
  readonly kind: TaskLifecycleEvent['kind'];
  readonly workflowId: string;
  readonly taskId: string;
  readonly status?: TaskStatus;
  readonly previousStatus?: TaskStatus;
  readonly taskStateVersion: number;
  readonly generation: number;
  readonly attemptId?: string;
  readonly createdAt?: Date;
}): TaskLifecycleEvent {
  const createdAt = lifecycleCreatedAt(input.createdAt);
  const eventKey = buildLifecycleEventKey(input);
  return {
    eventKey,
    kind: input.kind,
    workflowId: input.workflowId,
    taskId: input.taskId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.previousStatus ? { previousStatus: input.previousStatus } : {}),
    taskStateVersion: input.taskStateVersion,
    generation: input.generation,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    createdAt,
    recoveryWakeup: buildRecoveryWorkerWakeupHint({
      eventKey,
      eventKind: input.kind,
      workflowId: input.workflowId,
      taskId: input.taskId,
      taskStateVersion: input.taskStateVersion,
      generation: input.generation,
      attemptId: input.attemptId,
      createdAt,
      reason: input.kind === 'task.failed' ? 'task_failure' : 'task_lifecycle',
    }),
  };
}

function buildRecoveryWorkerWakeupHint(input: {
  readonly eventKey: string;
  readonly eventKind: WorkflowLifecycleEventKind;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly taskStateVersion?: number;
  readonly generation: number;
  readonly attemptId?: string;
  readonly createdAt: string;
  readonly reason: RecoveryWorkerWakeupReason;
}): RecoveryWorkerWakeupHint {
  return {
    eventKey: input.eventKey,
    eventKind: input.eventKind,
    workflowId: input.workflowId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskStateVersion != null ? { taskStateVersion: input.taskStateVersion } : {}),
    generation: input.generation,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    createdAt: input.createdAt,
    reason: input.reason,
    authoritative: false,
  };
}

function lifecycleCreatedAt(createdAt: unknown): string {
  const value = createdAt ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('createdAt must be a valid Date');
  }
  return value.toISOString();
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}

function requireWorkflowId(workflowId: string | undefined, taskId: string): string {
  if (workflowId) return workflowId;
  throw new Error(`workflowId is required to build lifecycle event for task ${taskId}`);
}

function requireTaskStatus(status: TaskStatus | undefined, taskId: string): TaskStatus {
  if (status) return status;
  throw new Error(`status is required to build lifecycle event for task ${taskId}`);
}

function isWorkflowLifecycleStatus(value: unknown): value is WorkflowLifecycleStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return isWorkflowLifecycleStatus(value);
}

function isRecoveryWorkerWakeupHint(
  value: unknown,
  event: {
    readonly eventKey?: unknown;
    readonly kind?: unknown;
    readonly workflowId?: unknown;
    readonly taskId?: unknown;
    readonly taskStateVersion?: unknown;
    readonly generation?: unknown;
    readonly attemptId?: unknown;
    readonly createdAt?: unknown;
  },
): value is RecoveryWorkerWakeupHint {
  if (!isRecord(value)) return false;
  if (value.eventKey !== event.eventKey) return false;
  if (value.eventKind !== event.kind) return false;
  if (value.workflowId !== event.workflowId) return false;
  if (value.taskId !== event.taskId) return false;
  if (value.taskStateVersion !== event.taskStateVersion) return false;
  if (value.generation !== event.generation) return false;
  if (value.attemptId !== event.attemptId) return false;
  if (value.createdAt !== event.createdAt) return false;
  if (value.authoritative !== false) return false;
  return value.reason === 'task_lifecycle'
    || value.reason === 'task_failure'
    || value.reason === 'review_gate_failure'
    || value.reason === 'workflow_reconcile';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
