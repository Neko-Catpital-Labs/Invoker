import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskDelta, TaskState, TaskStatus } from '@invoker/workflow-core';
import {
  buildTaskCreatedLifecycleEvent,
  buildTaskRemovedLifecycleEvent,
  buildTaskUpdatedLifecycleEvent,
  type WorkflowLifecycleEvent,
} from './lifecycle-events.js';

interface LifecycleTaskMetadata {
  readonly workflowId: string;
  readonly status: TaskStatus;
  readonly taskStateVersion: number;
  readonly generation: number;
  readonly attemptId?: string;
}

export interface LifecycleEventBridgeOptions {
  readonly messageBus: MessageBus;
  readonly getInitialTasks?: () => readonly TaskState[];
  readonly getTask?: (taskId: string) => TaskState | undefined;
  readonly now?: () => string | Date;
  readonly logger?: {
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface LifecycleEventBridge {
  readonly stop: Unsubscribe;
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
