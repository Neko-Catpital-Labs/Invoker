/**
 * Merge gate utilities — pure functions for computing the synthetic merge gate node.
 */

import type { TaskState, TaskStatus } from '../types.js';

/** Per-workflow merge gate ID. */
export function mergeGateId(workflowId: string): string {
  return `__merge_gate__${workflowId}`;
}

/** Check if an ID is a merge gate ID. */
export function isMergeGateId(id: string): boolean {
  return id.startsWith('__merge_gate__');
}

/** Backward-compatible constant for single-workflow usage. */
export const MERGE_GATE_ID = '__merge_gate__';

/** Compute the merge gate status from a set of tasks. */
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

/** Group tasks by workflowId. Tasks without a workflowId go into 'unknown'. */
export function groupTasksByWorkflow(tasks: TaskState[]): Map<string, TaskState[]> {
  const groups = new Map<string, TaskState[]>();
  for (const task of tasks) {
    const wfId = task.workflowId ?? 'unknown';
    if (!groups.has(wfId)) groups.set(wfId, []);
    groups.get(wfId)!.push(task);
  }
  return groups;
}
