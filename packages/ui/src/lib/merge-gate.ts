/**
 * Merge gate utilities — pure functions for computing the synthetic merge gate node.
 */

import type { TaskState, TaskStatus } from '../types.js';

export const MERGE_GATE_ID = '__merge_gate__';

/** Compute the merge gate status from all tasks. */
export function computeMergeGateStatus(tasks: TaskState[]): TaskStatus {
  let anyFailed = false;
  let allCompleted = true;
  for (const t of tasks) {
    if (t.status === 'failed' || t.status === 'blocked') anyFailed = true;
    if (t.status !== 'completed') allCompleted = false;
  }
  if (anyFailed) return 'failed';
  if (allCompleted && tasks.length > 0) return 'completed';
  return 'pending';
}

/** Find leaf tasks — tasks that no other task depends on. */
export function findLeafTasks(tasks: TaskState[]): TaskState[] {
  const dependedOn = new Set<string>();
  for (const task of tasks) {
    for (const dep of task.dependencies) dependedOn.add(dep);
  }
  return tasks.filter(t => !dependedOn.has(t.id));
}
