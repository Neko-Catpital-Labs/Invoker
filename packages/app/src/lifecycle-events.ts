import type { TaskDelta, TaskState, TaskStatus } from '@invoker/workflow-core';

export const WorkerLifecycleEventKinds = {
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_REVIEW_READY: 'task.review_ready',
  TASK_AWAITING_APPROVAL: 'task.awaiting_approval',
  TASK_NEEDS_INPUT: 'task.needs_input',
  TASK_REMOVED: 'task.removed',
  REVIEW_GATE_CI_FAILED: 'review_gate.ci_failed',
  WORKFLOW_WAKEUP: 'workflow.wakeup',
} as const;

export type WorkerLifecycleEventKind =
  typeof WorkerLifecycleEventKinds[keyof typeof WorkerLifecycleEventKinds];

export interface WorkerLifecycleEventBase {
  readonly key: string;
  readonly kind: WorkerLifecycleEventKind;
  readonly workflowId: string;
  readonly taskId?: string;
  readonly status?: TaskStatus;
  readonly previousStatus?: TaskStatus;
  readonly taskStateVersion?: number;
  readonly previousTaskStateVersion?: number;
  readonly generation?: number;
  readonly attemptId?: string;
  readonly createdAt: string;
}

export interface TaskCreatedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_CREATED;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly taskStateVersion: number;
}

export interface TaskUpdatedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_UPDATED;
  readonly taskId: string;
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskCompletedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_COMPLETED;
  readonly taskId: string;
  readonly status: 'completed';
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskFailedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_FAILED;
  readonly taskId: string;
  readonly status: 'failed';
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskReviewReadyLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_REVIEW_READY;
  readonly taskId: string;
  readonly status: 'review_ready';
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskAwaitingApprovalLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_AWAITING_APPROVAL;
  readonly taskId: string;
  readonly status: 'awaiting_approval';
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskNeedsInputLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_NEEDS_INPUT;
  readonly taskId: string;
  readonly status: 'needs_input';
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface TaskRemovedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.TASK_REMOVED;
  readonly taskId: string;
  readonly taskStateVersion: number;
  readonly previousTaskStateVersion: number;
}

export interface ReviewGateCiFailedLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.REVIEW_GATE_CI_FAILED;
  readonly taskId: string;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly failedCheckCount: number;
  readonly statusText: string;
}

export interface WorkflowWakeupLifecycleEvent extends WorkerLifecycleEventBase {
  readonly kind: typeof WorkerLifecycleEventKinds.WORKFLOW_WAKEUP;
  readonly reason:
    | 'startup_reconcile'
    | 'periodic_reconcile'
    | 'manual_reconcile'
    | 'workflow_recreated'
    | 'workflow_loaded';
}

export type WorkerLifecycleEvent =
  | TaskCreatedLifecycleEvent
  | TaskUpdatedLifecycleEvent
  | TaskCompletedLifecycleEvent
  | TaskFailedLifecycleEvent
  | TaskReviewReadyLifecycleEvent
  | TaskAwaitingApprovalLifecycleEvent
  | TaskNeedsInputLifecycleEvent
  | TaskRemovedLifecycleEvent
  | ReviewGateCiFailedLifecycleEvent
  | WorkflowWakeupLifecycleEvent;

export interface LifecycleEventBuildOptions {
  readonly workflowId?: string;
  readonly previousStatus?: TaskStatus;
  readonly createdAt?: Date | string;
  readonly generation?: number;
  readonly attemptId?: string;
}

export interface ReviewGateCiFailedLifecycleInput {
  readonly workflowId: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly status?: TaskStatus;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly selectedAttemptId?: string;
  readonly generation: number;
  readonly taskStateVersion?: number;
  readonly failedChecks?: readonly unknown[];
  readonly failedCheckCount?: number;
  readonly statusText: string;
}

export interface WorkflowWakeupLifecycleInput {
  readonly workflowId: string;
  readonly reason: WorkflowWakeupLifecycleEvent['reason'];
  readonly generation?: number;
  readonly createdAt?: Date | string;
}

export function createTaskLifecycleEventFromDelta(
  delta: TaskDelta,
  options: LifecycleEventBuildOptions = {},
): WorkerLifecycleEvent {
  if (delta.type === 'created') {
    return createTaskCreatedLifecycleEvent(delta.task, options);
  }
  if (delta.type === 'removed') {
    const workflowId = requireWorkflowId(options.workflowId, delta.taskId);
    const createdAt = normalizeCreatedAt(options.createdAt);
    return {
      key: lifecycleEventKey(
        WorkerLifecycleEventKinds.TASK_REMOVED,
        workflowId,
        delta.taskId,
        delta.previousTaskStateVersion,
      ),
      kind: WorkerLifecycleEventKinds.TASK_REMOVED,
      workflowId,
      taskId: delta.taskId,
      taskStateVersion: delta.previousTaskStateVersion,
      previousTaskStateVersion: delta.previousTaskStateVersion,
      generation: options.generation,
      attemptId: options.attemptId,
      createdAt,
    };
  }

  const workflowId = requireWorkflowId(options.workflowId, delta.taskId);
  const status = delta.changes.status;
  const kind = lifecycleKindForStatus(status);
  const createdAt = normalizeCreatedAt(options.createdAt);
  const base = {
    key: lifecycleEventKey(
      kind,
      workflowId,
      delta.taskId,
      delta.previousTaskStateVersion,
      delta.taskStateVersion,
      status ?? 'no-status',
      options.generation,
      options.attemptId,
    ),
    kind,
    workflowId,
    taskId: delta.taskId,
    status,
    previousStatus: options.previousStatus,
    taskStateVersion: delta.taskStateVersion,
    previousTaskStateVersion: delta.previousTaskStateVersion,
    generation: options.generation,
    attemptId: options.attemptId,
    createdAt,
  };

  if (kind === WorkerLifecycleEventKinds.TASK_COMPLETED) {
    return { ...base, kind, status: 'completed' };
  }
  if (kind === WorkerLifecycleEventKinds.TASK_FAILED) {
    return { ...base, kind, status: 'failed' };
  }
  if (kind === WorkerLifecycleEventKinds.TASK_REVIEW_READY) {
    return { ...base, kind, status: 'review_ready' };
  }
  if (kind === WorkerLifecycleEventKinds.TASK_AWAITING_APPROVAL) {
    return { ...base, kind, status: 'awaiting_approval' };
  }
  if (kind === WorkerLifecycleEventKinds.TASK_NEEDS_INPUT) {
    return { ...base, kind, status: 'needs_input' };
  }
  return { ...base, kind };
}

export function createTaskCreatedLifecycleEvent(
  task: TaskState,
  options: LifecycleEventBuildOptions = {},
): TaskCreatedLifecycleEvent {
  const workflowId = requireWorkflowId(options.workflowId ?? task.config.workflowId, task.id);
  const generation = options.generation ?? task.execution.generation;
  const attemptId = options.attemptId ?? task.execution.selectedAttemptId;
  return {
    key: lifecycleEventKey(
      WorkerLifecycleEventKinds.TASK_CREATED,
      workflowId,
      task.id,
      task.taskStateVersion,
      task.status,
      generation,
      attemptId,
    ),
    kind: WorkerLifecycleEventKinds.TASK_CREATED,
    workflowId,
    taskId: task.id,
    status: task.status,
    previousStatus: options.previousStatus,
    taskStateVersion: task.taskStateVersion,
    generation,
    attemptId,
    createdAt: normalizeCreatedAt(options.createdAt),
  };
}

export function createReviewGateCiFailedLifecycleEvent(
  input: ReviewGateCiFailedLifecycleInput,
  options: Pick<LifecycleEventBuildOptions, 'createdAt'> = {},
): ReviewGateCiFailedLifecycleEvent {
  const failedCheckCount = input.failedCheckCount ?? input.failedChecks?.length ?? 0;
  return {
    key: lifecycleEventKey(
      WorkerLifecycleEventKinds.REVIEW_GATE_CI_FAILED,
      input.workflowId,
      input.taskId,
      input.reviewId,
      input.headSha,
      input.generation,
      input.selectedAttemptId,
    ),
    kind: WorkerLifecycleEventKinds.REVIEW_GATE_CI_FAILED,
    workflowId: input.workflowId,
    taskId: input.taskId,
    status: input.status,
    taskStateVersion: input.taskStateVersion,
    generation: input.generation,
    attemptId: input.selectedAttemptId,
    reviewId: input.reviewId,
    reviewUrl: input.reviewUrl,
    headSha: input.headSha,
    headRef: input.headRef,
    branch: input.branch,
    failedCheckCount,
    statusText: input.statusText,
    createdAt: normalizeCreatedAt(options.createdAt),
  };
}

export function createWorkflowWakeupLifecycleEvent(
  input: WorkflowWakeupLifecycleInput,
): WorkflowWakeupLifecycleEvent {
  return {
    key: lifecycleEventKey(
      WorkerLifecycleEventKinds.WORKFLOW_WAKEUP,
      input.workflowId,
      input.reason,
      input.generation,
    ),
    kind: WorkerLifecycleEventKinds.WORKFLOW_WAKEUP,
    workflowId: input.workflowId,
    reason: input.reason,
    generation: input.generation,
    createdAt: normalizeCreatedAt(input.createdAt),
  };
}

export function isWorkerLifecycleEvent(value: unknown): value is WorkerLifecycleEvent {
  if (!isRecord(value)) return false;
  if (typeof value.key !== 'string' || value.key.length === 0) return false;
  if (!isWorkerLifecycleEventKind(value.kind)) return false;
  if (typeof value.workflowId !== 'string' || value.workflowId.length === 0) return false;
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.taskId !== undefined && typeof value.taskId !== 'string') return false;
  if (value.generation !== undefined && typeof value.generation !== 'number') return false;
  if (value.taskStateVersion !== undefined && typeof value.taskStateVersion !== 'number') return false;
  if (value.previousTaskStateVersion !== undefined && typeof value.previousTaskStateVersion !== 'number') return false;
  if (value.attemptId !== undefined && typeof value.attemptId !== 'string') return false;
  return true;
}

export function isWorkerLifecycleEventKind(value: unknown): value is WorkerLifecycleEventKind {
  return typeof value === 'string'
    && (Object.values(WorkerLifecycleEventKinds) as string[]).includes(value);
}

export function lifecycleEventKey(
  kind: WorkerLifecycleEventKind,
  ...parts: readonly (string | number | undefined | null)[]
): string {
  return [
    'lifecycle',
    kind,
    ...parts.map((part) => part === undefined || part === null ? 'none' : String(part)),
  ].map(encodeURIComponent).join(':');
}

function requireWorkflowId(workflowId: string | undefined, taskId: string): string {
  if (workflowId?.trim()) return workflowId;
  throw new Error(`workflowId is required for lifecycle event for task ${taskId}`);
}

function normalizeCreatedAt(createdAt: Date | string | undefined): string {
  if (createdAt instanceof Date) return createdAt.toISOString();
  if (typeof createdAt === 'string') return createdAt;
  return new Date().toISOString();
}

function lifecycleKindForStatus(status: TaskStatus | undefined): WorkerLifecycleEventKind {
  switch (status) {
    case 'completed':
      return WorkerLifecycleEventKinds.TASK_COMPLETED;
    case 'failed':
      return WorkerLifecycleEventKinds.TASK_FAILED;
    case 'review_ready':
      return WorkerLifecycleEventKinds.TASK_REVIEW_READY;
    case 'awaiting_approval':
      return WorkerLifecycleEventKinds.TASK_AWAITING_APPROVAL;
    case 'needs_input':
      return WorkerLifecycleEventKinds.TASK_NEEDS_INPUT;
    default:
      return WorkerLifecycleEventKinds.TASK_UPDATED;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
