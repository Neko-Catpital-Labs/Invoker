/**
 * Applies a TaskDelta to an immutable task map, returning a new map.
 *
 * Three delta types:
 * - created: adds a new task
 * - updated: merges changes into an existing task (with nested config/execution)
 * - removed: deletes a task
 */

import type { TaskState, TaskDelta } from '../types.js';

export function applyDeltaInPlace(
  target: Map<string, TaskState>,
  delta: TaskDelta,
): void {
  switch (delta.type) {
    case 'created':
      target.set(delta.task.id, delta.task);
      break;

    case 'updated': {
      const existing = target.get(delta.taskId);
      if (existing) {
        const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
        target.set(delta.taskId, {
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
      target.delete(delta.taskId);
      break;
  }
}

export function applyDelta(
  tasks: Map<string, TaskState>,
  delta: TaskDelta,
): Map<string, TaskState> {
  const next = new Map(tasks);
  applyDeltaInPlace(next, delta);
  return next;
}

export function applyDeltas(
  tasks: Map<string, TaskState>,
  deltas: readonly TaskDelta[],
): Map<string, TaskState> {
  if (deltas.length === 0) {
    return tasks;
  }
  const next = new Map(tasks);
  for (const delta of deltas) {
    applyDeltaInPlace(next, delta);
  }
  return next;
}
