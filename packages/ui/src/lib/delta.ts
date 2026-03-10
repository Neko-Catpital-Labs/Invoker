/**
 * Applies a TaskDelta to an immutable task map, returning a new map.
 *
 * Three delta types:
 * - created: adds a new task
 * - updated: merges changes into an existing task
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
        next.set(delta.taskId, { ...existing, ...delta.changes });
      }
      break;
    }

    case 'removed':
      next.delete(delta.taskId);
      break;
  }

  return next;
}
