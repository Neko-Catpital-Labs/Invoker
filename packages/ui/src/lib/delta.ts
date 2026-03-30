/**
 * Applies a TaskDelta to an immutable task map, returning a new map.
 *
 * Three delta types:
 * - created: adds a new task
 * - updated: merges changes into an existing task (with nested config/execution)
 * - removed: deletes a task
 */

import type { TaskState, TaskDelta } from '../types.js';

export function applyDelta(
  tasks: Map<string, TaskState>,
  delta: TaskDelta,
): Map<string, TaskState> {
  const next = new Map(tasks);

  switch (delta.type) {
    case 'created':
      next.set(delta.task.id, delta.task);
      break;

    case 'updated': {
      const existing = next.get(delta.taskId);
      if (existing) {
        const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
        next.set(delta.taskId, {
          ...existing,
          ...topLevel,
          config: { ...existing.config, ...cfgChanges },
          execution: { ...existing.execution, ...execChanges },
        });
      } else {
        console.warn(
          `[applyDelta] dropped updated delta — task not in map (taskId=${delta.taskId})`,
        );
      }
      break;
    }

    case 'removed':
      next.delete(delta.taskId);
      break;
  }

  return next;
}
