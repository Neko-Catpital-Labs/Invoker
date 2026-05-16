import type { TaskDelta, TaskState, TaskStateChanges } from '@invoker/workflow-graph';

export const TASK_DELTA_CHANNEL = 'task.delta';

export interface TaskDeltaMessageBus {
  publish<T>(channel: string, message: T): void;
}

export interface TaskDeltaEventHost {
  readonly messageBus: TaskDeltaMessageBus;
}

export function buildTaskUpdateDelta(
  before: TaskState,
  after: TaskState,
  changes: TaskStateChanges,
): TaskDelta {
  return {
    type: 'updated',
    taskId: after.id,
    changes,
    taskStateVersion: after.taskStateVersion,
    previousTaskStateVersion: before.taskStateVersion,
  };
}

export function buildTaskRemoveDelta(task: TaskState): TaskDelta {
  return {
    type: 'removed',
    taskId: task.id,
    previousTaskStateVersion: task.taskStateVersion,
  };
}

export function publishTaskDelta(host: TaskDeltaEventHost, delta: TaskDelta): void {
  host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
}

export function publishTaskCreated(host: TaskDeltaEventHost, task: TaskState): void {
  publishTaskDelta(host, { type: 'created', task });
}

export function publishTaskUpdated(
  host: TaskDeltaEventHost,
  before: TaskState,
  after: TaskState,
  changes: TaskStateChanges,
): void {
  publishTaskDelta(host, buildTaskUpdateDelta(before, after, changes));
}

export function publishTaskRemoved(host: TaskDeltaEventHost, task: TaskState): void {
  publishTaskDelta(host, buildTaskRemoveDelta(task));
}
