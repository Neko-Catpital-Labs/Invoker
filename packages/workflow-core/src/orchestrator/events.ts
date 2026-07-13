/**
 * Extracted event-publication domain.
 *
 * Centralizes the `task.delta` event contract: the channel constant, the
 * `TaskDelta` builders, and the MessageBus publish helper. The Orchestrator
 * and the other extracted domains (scheduler, transitions, merge) build and
 * publish deltas through these functions, keeping the delta payload shape and
 * channel name defined in exactly one place (see `graph-mutation.ts` for the
 * same host-delegation pattern).
 *
 * Behavior is intentionally identical to the previous in-class helpers:
 * the `updated`/`removed` payload fields, task-state continuity metadata, and
 * the `task.delta` channel are preserved exactly so the TASK_DELTA publication
 * contract stays stable.
 */

import type { TaskState, TaskDelta, TaskStateChanges } from '@invoker/workflow-graph';
import type { OrchestratorMessageBus } from '../orchestrator.js';

/** Channel on which all task deltas are published. */
export const TASK_DELTA_CHANNEL = 'task.delta';

/**
 * Build an 'updated' TaskDelta with task-state continuity metadata.
 * `before` is the task state before the mutation, `after` is the state
 * returned by writeAndSync.
 */
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

/**
 * Build a 'removed' TaskDelta with the task's last known task-state version.
 */
export function buildTaskRemoveDelta(task: TaskState): TaskDelta {
  return {
    type: 'removed',
    taskId: task.id,
    previousTaskStateVersion: task.taskStateVersion,
  };
}

/** Publish a task delta on the canonical `task.delta` channel. */
export function publishTaskDelta(messageBus: OrchestratorMessageBus, delta: TaskDelta): void {
  messageBus.publish(TASK_DELTA_CHANNEL, delta);
}
