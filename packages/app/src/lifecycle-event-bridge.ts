import type { PrMirrorRow } from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskDelta, TaskState, TaskStatus } from '@invoker/workflow-core';
import {
  buildReviewGateCiFailedLifecycleEvent,
  buildReviewGateMergeConflictLifecycleEvent,
  buildTaskCreatedLifecycleEvent,
  buildTaskRemovedLifecycleEvent,
  buildTaskUpdatedLifecycleEvent,
  type ReviewGateFailedCheck,
  type WorkflowLifecycleEvent,
} from './lifecycle-events.js';

interface LifecycleTaskMetadata {
  readonly workflowId: string;
  readonly status: TaskStatus;
  readonly taskStateVersion: number;
  readonly generation: number;
  readonly attemptId?: string;
}

export interface PrMirrorUpsertStore {
  upsertPrMirror(mirror: PrMirrorRow): PrMirrorRow;
}

export interface LifecycleEventBridgeOptions {
  readonly messageBus: MessageBus;
  readonly getInitialTasks?: () => readonly TaskState[];
  readonly getTask?: (taskId: string) => TaskState | undefined;
  readonly prMirrorStore?: PrMirrorUpsertStore;
  readonly now?: () => Date;
  readonly logger?: {
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface LifecycleEventBridge {
  readonly stop: Unsubscribe;
}

export interface ReviewGateCiFailedWakeupInput {
  readonly workflowId: string;
  readonly taskId: string;
  readonly status?: TaskStatus;
  readonly taskStateVersion?: number;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly mergeState?: string;
  readonly labelsJson?: string;
  readonly selectedAttemptId?: string;
  readonly generation: number;
  readonly failedChecks: readonly ReviewGateFailedCheck[];
  readonly statusText: string;
}

export interface ReviewGateMergeConflictWakeupInput {
  readonly workflowId: string;
  readonly taskId: string;
  readonly status?: TaskStatus;
  readonly taskStateVersion?: number;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly mergeState?: string;
  readonly labelsJson?: string;
  readonly selectedAttemptId?: string;
  readonly generation: number;
  readonly statusText: string;
}

export function startLifecycleEventBridge(options: LifecycleEventBridgeOptions): LifecycleEventBridge {
  const taskMetadata = new Map<string, LifecycleTaskMetadata>();

  for (const task of options.getInitialTasks?.() ?? []) {
    rememberTask(taskMetadata, task);
  }

  const stop = options.messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    try {
      const event = buildEventForTaskDelta(delta, taskMetadata, options);
      updateTaskMetadata(delta, taskMetadata, options);
      if (event) {
        options.messageBus.publish(Channels.WORKFLOW_LIFECYCLE, event);
      }
    } catch (err) {
      options.logger?.warn('failed to publish workflow lifecycle event from task delta', {
        module: 'lifecycle-event-bridge',
        err,
        delta,
      });
    }
  });

  return { stop };
}

export function publishReviewGateCiFailedLifecycleEvent(
  input: ReviewGateCiFailedWakeupInput,
  options: Pick<LifecycleEventBridgeOptions, 'messageBus' | 'getTask' | 'prMirrorStore' | 'now' | 'logger'>,
): WorkflowLifecycleEvent | undefined {
  const currentTask = options.getTask?.(input.taskId);
  const status = input.status ?? currentTask?.status;
  const taskStateVersion = input.taskStateVersion ?? currentTask?.taskStateVersion;
  const attemptId = input.selectedAttemptId ?? currentTask?.execution.selectedAttemptId;
  if (!status || taskStateVersion == null) return undefined;

  const event = buildReviewGateCiFailedLifecycleEvent({
    workflowId: input.workflowId,
    taskId: input.taskId,
    status,
    taskStateVersion,
    reviewId: input.reviewId,
    reviewUrl: input.reviewUrl,
    headSha: input.headSha,
    headRef: input.headRef,
    branch: input.branch,
    failedChecks: input.failedChecks,
    statusText: input.statusText,
    generation: input.generation,
    attemptId,
    createdAt: options.now?.(),
  });
  upsertReviewGatePrMirrorBeforePublish({
    kind: 'ci_failed',
    input,
    options,
  });
  options.messageBus.publish(Channels.WORKFLOW_LIFECYCLE, event);
  return event;
}

export function publishReviewGateMergeConflictLifecycleEvent(
  input: ReviewGateMergeConflictWakeupInput,
  options: Pick<LifecycleEventBridgeOptions, 'messageBus' | 'getTask' | 'prMirrorStore' | 'now' | 'logger'>,
): WorkflowLifecycleEvent | undefined {
  const currentTask = options.getTask?.(input.taskId);
  const status = input.status ?? currentTask?.status;
  const taskStateVersion = input.taskStateVersion ?? currentTask?.taskStateVersion;
  const attemptId = input.selectedAttemptId ?? currentTask?.execution.selectedAttemptId;
  if (!status || taskStateVersion == null) return undefined;

  const event = buildReviewGateMergeConflictLifecycleEvent({
    workflowId: input.workflowId,
    taskId: input.taskId,
    status,
    taskStateVersion,
    reviewId: input.reviewId,
    reviewUrl: input.reviewUrl,
    headSha: input.headSha,
    headRef: input.headRef,
    branch: input.branch,
    statusText: input.statusText,
    generation: input.generation,
    attemptId,
    createdAt: options.now?.(),
  });
  upsertReviewGatePrMirrorBeforePublish({
    kind: 'merge_conflict',
    input,
    options,
  });
  options.messageBus.publish(Channels.WORKFLOW_LIFECYCLE, event);
  return event;
}

export function resolveReviewGatePrIdentity(
  reviewUrl: string,
  reviewId: string,
): { repo: string; prNumber: number } | undefined {
  const fromUrl = reviewUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (fromUrl?.[1] && fromUrl[2]) {
    return { repo: fromUrl[1], prNumber: Number(fromUrl[2]) };
  }
  const fromId = reviewId.match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  if (fromId?.[1] && fromId[2]) {
    return { repo: fromId[1], prNumber: Number(fromId[2]) };
  }
  return undefined;
}

function upsertReviewGatePrMirrorBeforePublish(args: {
  readonly kind: 'ci_failed' | 'merge_conflict';
  readonly input: ReviewGateCiFailedWakeupInput | ReviewGateMergeConflictWakeupInput;
  readonly options: Pick<LifecycleEventBridgeOptions, 'prMirrorStore' | 'now' | 'logger'>;
}): void {
  const store = args.options.prMirrorStore;
  if (!store) return;

  const identity = resolveReviewGatePrIdentity(args.input.reviewUrl, args.input.reviewId);
  if (!identity || !args.input.headSha) {
    args.options.logger?.warn('skipping pr_mirrors upsert before review-gate lifecycle publish', {
      module: 'lifecycle-event-bridge',
      kind: args.kind,
      reviewId: args.input.reviewId,
      reviewUrl: args.input.reviewUrl,
      headSha: args.input.headSha,
    });
    return;
  }

  const updatedAt = (args.options.now?.() ?? new Date()).toISOString();
  const blockers: Record<string, unknown> = { kind: args.kind };
  if (args.kind === 'ci_failed' && 'failedChecks' in args.input) {
    blockers.failedChecks = args.input.failedChecks.map((check) => check.name);
  }

  const mirror: PrMirrorRow = {
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: args.input.headSha,
    ...(args.input.baseRef ? { baseRef: args.input.baseRef } : {}),
    ...(args.input.mergeState ? { mergeState: args.input.mergeState } : {}),
    ...(args.input.labelsJson ? { labelsJson: args.input.labelsJson } : {}),
    workflowId: args.input.workflowId,
    blockersJson: JSON.stringify(blockers),
    updatedAt,
  };
  store.upsertPrMirror(mirror);
}

function buildEventForTaskDelta(
  delta: TaskDelta,
  taskMetadata: ReadonlyMap<string, LifecycleTaskMetadata>,
  options: LifecycleEventBridgeOptions,
): WorkflowLifecycleEvent | undefined {
  const createdAt = options.now?.();
  switch (delta.type) {
    case 'created':
      return buildTaskCreatedLifecycleEvent(delta.task, { createdAt });
    case 'updated': {
      const currentTask = options.getTask?.(delta.taskId);
      const previous = taskMetadata.get(delta.taskId);
      const status = delta.changes.status ?? currentTask?.status ?? previous?.status;
      const workflowId = currentTask?.config.workflowId ?? previous?.workflowId ?? inferWorkflowIdFromTaskId(delta.taskId);
      if (!status || !workflowId) return undefined;
      return buildTaskUpdatedLifecycleEvent({
        workflowId,
        taskId: delta.taskId,
        status,
        previousStatus: previous?.status,
        taskStateVersion: delta.taskStateVersion,
        generation: delta.changes.execution?.generation
          ?? currentTask?.execution.generation
          ?? previous?.generation
          ?? 0,
        attemptId: delta.changes.execution?.selectedAttemptId
          ?? currentTask?.execution.selectedAttemptId
          ?? previous?.attemptId,
        createdAt,
      });
    }
    case 'removed': {
      const previous = taskMetadata.get(delta.taskId);
      const workflowId = previous?.workflowId ?? inferWorkflowIdFromTaskId(delta.taskId);
      if (!workflowId) return undefined;
      return buildTaskRemovedLifecycleEvent({
        workflowId,
        taskId: delta.taskId,
        status: previous?.status,
        previousStatus: previous?.status,
        taskStateVersion: delta.previousTaskStateVersion,
        generation: previous?.generation ?? 0,
        attemptId: previous?.attemptId,
        createdAt,
      });
    }
  }
}

function updateTaskMetadata(
  delta: TaskDelta,
  taskMetadata: Map<string, LifecycleTaskMetadata>,
  options: LifecycleEventBridgeOptions,
): void {
  switch (delta.type) {
    case 'created':
      rememberTask(taskMetadata, delta.task);
      return;
    case 'updated': {
      const currentTask = options.getTask?.(delta.taskId);
      if (currentTask) {
        rememberTask(taskMetadata, currentTask);
        return;
      }
      const previous = taskMetadata.get(delta.taskId);
      const workflowId = previous?.workflowId ?? inferWorkflowIdFromTaskId(delta.taskId);
      const status = delta.changes.status ?? previous?.status;
      if (!workflowId || !status) return;
      taskMetadata.set(delta.taskId, {
        workflowId,
        status,
        taskStateVersion: delta.taskStateVersion,
        generation: delta.changes.execution?.generation ?? previous?.generation ?? 0,
        attemptId: delta.changes.execution?.selectedAttemptId ?? previous?.attemptId,
      });
      return;
    }
    case 'removed':
      taskMetadata.delete(delta.taskId);
      return;
  }
}

function rememberTask(
  taskMetadata: Map<string, LifecycleTaskMetadata>,
  task: TaskState,
): void {
  const workflowId = task.config.workflowId ?? inferWorkflowIdFromTaskId(task.id);
  if (!workflowId) return;
  taskMetadata.set(task.id, {
    workflowId,
    status: task.status,
    taskStateVersion: task.taskStateVersion,
    generation: task.execution.generation ?? 0,
    attemptId: task.execution.selectedAttemptId,
  });
}

function inferWorkflowIdFromTaskId(taskId: string): string | undefined {
  const slashIndex = taskId.indexOf('/');
  if (slashIndex <= 0) return undefined;
  return taskId.slice(0, slashIndex);
}
