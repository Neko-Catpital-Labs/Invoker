import type { MessageBus, Unsubscribe } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { TaskDelta, TaskStatus } from '@invoker/workflow-core';

import {
  createTaskLifecycleEventFromDelta,
  type WorkerLifecycleEvent,
} from './lifecycle-events.js';

export interface LifecycleEventBridge {
  readonly stop: () => void;
}

export interface LifecycleEventBridgeOptions {
  readonly now?: () => Date | string;
  readonly resolveWorkflowId?: (taskId: string) => string | undefined;
}

interface TaskLifecycleMetadata {
  readonly workflowId?: string;
  readonly status?: TaskStatus;
  readonly generation?: number;
  readonly attemptId?: string;
}

export function startLifecycleEventBridge(
  messageBus: MessageBus,
  options: LifecycleEventBridgeOptions = {},
): LifecycleEventBridge {
  const taskMetadata = new Map<string, TaskLifecycleMetadata>();

  const unsubscribe = messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    const metadata = metadataForDelta(delta, taskMetadata, options);
    const createdAt = options.now?.();
    const event = createTaskLifecycleEventFromDelta(delta, {
      workflowId: metadata.workflowId,
      previousStatus: metadata.status,
      generation: metadata.generation,
      attemptId: metadata.attemptId,
      createdAt,
    });

    messageBus.publish<WorkerLifecycleEvent>(Channels.WORKFLOW_LIFECYCLE, event);
    updateMetadataFromDelta(delta, taskMetadata, metadata);
  });

  return { stop: once(unsubscribe) };
}

function metadataForDelta(
  delta: TaskDelta,
  taskMetadata: Map<string, TaskLifecycleMetadata>,
  options: LifecycleEventBridgeOptions,
): TaskLifecycleMetadata {
  if (delta.type === 'created') {
    return {
      workflowId: delta.task.config.workflowId ?? deriveWorkflowIdFromTaskId(delta.task.id),
      status: undefined,
      generation: delta.task.execution.generation,
      attemptId: delta.task.execution.selectedAttemptId,
    };
  }

  const cached = taskMetadata.get(delta.taskId);
  return {
    workflowId: cached?.workflowId ?? options.resolveWorkflowId?.(delta.taskId) ?? deriveWorkflowIdFromTaskId(delta.taskId),
    status: cached?.status,
    generation: delta.type === 'updated' ? delta.changes.execution?.generation ?? cached?.generation : cached?.generation,
    attemptId: delta.type === 'updated' ? delta.changes.execution?.selectedAttemptId ?? cached?.attemptId : cached?.attemptId,
  };
}

function updateMetadataFromDelta(
  delta: TaskDelta,
  taskMetadata: Map<string, TaskLifecycleMetadata>,
  previousMetadata: TaskLifecycleMetadata,
): void {
  if (delta.type === 'removed') {
    taskMetadata.delete(delta.taskId);
    return;
  }

  if (delta.type === 'created') {
    taskMetadata.set(delta.task.id, {
      workflowId: delta.task.config.workflowId ?? deriveWorkflowIdFromTaskId(delta.task.id),
      status: delta.task.status,
      generation: delta.task.execution.generation,
      attemptId: delta.task.execution.selectedAttemptId,
    });
    return;
  }

  taskMetadata.set(delta.taskId, {
    workflowId: previousMetadata.workflowId,
    status: delta.changes.status ?? previousMetadata.status,
    generation: delta.changes.execution?.generation ?? previousMetadata.generation,
    attemptId: delta.changes.execution?.selectedAttemptId ?? previousMetadata.attemptId,
  });
}

function deriveWorkflowIdFromTaskId(taskId: string): string | undefined {
  const slashIndex = taskId.indexOf('/');
  if (slashIndex <= 0) return undefined;
  return taskId.slice(0, slashIndex);
}

function once(unsubscribe: Unsubscribe): Unsubscribe {
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
}
