/**
 * Merge gate utilities — pure functions for computing the synthetic merge gate node.
 */

import type { TaskState, TaskStatus, WorkflowMeta } from '../types.js';

/** How the terminal merge task finishes — drives a single primary label on the graph node. */
export type MergeGateKind = 'github_pr' | 'pull_request' | 'merge' | 'workflow';

const MERGE_DESC_PREFIXES: readonly { readonly prefix: string; readonly kind: MergeGateKind }[] = [
  { prefix: 'GitHub PR gate for ', kind: 'github_pr' },
  { prefix: 'Pull request gate for ', kind: 'pull_request' },
  { prefix: 'Merge gate for ', kind: 'merge' },
  { prefix: 'Workflow gate for ', kind: 'workflow' },
] as const;

/** Detect gate kind from orchestrator merge-task description (stable without workflow metadata). */
export function mergeGateKindFromDescription(description: string): MergeGateKind | undefined {
  for (const { prefix, kind } of MERGE_DESC_PREFIXES) {
    if (description.startsWith(prefix)) return kind;
  }
  return undefined;
}

/** Plan title only (strip orchestrator prefix) for subtitle under the primary gate label. */
export function mergeGatePlanTitle(description: string): string {
  for (const { prefix } of MERGE_DESC_PREFIXES) {
    if (description.startsWith(prefix)) return description.slice(prefix.length);
  }
  return description;
}

/** Case-insensitive strip of known gate prefixes (for stale rows / casing drift). */
export function mergeGatePlanTitleInsensitive(description: string): string {
  const lower = description.toLowerCase();
  for (const { prefix } of MERGE_DESC_PREFIXES) {
    const p = prefix.toLowerCase();
    if (lower.startsWith(p)) return description.slice(prefix.length);
  }
  return description;
}

/**
 * Task panel heading for merge nodes: when the workflow finishes via GitHub PR, always show
 * `GitHub PR gate for …` if the description uses any known gate prefix — avoids "Pull request …"
 * in the title alongside Merge mode "GitHub PR" (stale DB or onFinish vs mergeMode skew).
 */
export function mergeGatePanelHeading(task: TaskState, mergeMode?: string): string {
  if (!task.config.isMergeNode) return task.description;
  const githubUi = mergeMode === 'github' || Boolean(task.execution?.prUrl);
  if (!githubUi) return task.description;
  const lower = task.description.toLowerCase();
  const hadPrefix = MERGE_DESC_PREFIXES.some(p => lower.startsWith(p.prefix.toLowerCase()));
  if (hadPrefix) {
    return `GitHub PR gate for ${mergeGatePlanTitleInsensitive(task.description)}`;
  }
  return task.description;
}

/**
 * Resolve gate kind for DAG rendering. Prefer persisted description prefixes; fall back to workflow
 * meta for older DB rows or missing prefixes.
 */
export function resolveMergeGateKind(task: TaskState, wfMeta?: WorkflowMeta): MergeGateKind {
  const fromDesc = mergeGateKindFromDescription(task.description);
  if (fromDesc) return fromDesc;
  const mm = wfMeta?.mergeMode ?? 'manual';
  const of = (wfMeta?.onFinish as 'none' | 'merge' | 'pull_request' | undefined) ?? 'none';
  if (mm === 'github') return 'github_pr';
  if (of === 'pull_request') return 'pull_request';
  if (of === 'merge') return 'merge';
  return 'workflow';
}

/** Per-workflow merge gate ID. */
export function mergeGateId(workflowId: string): string {
  return `__merge_gate__${workflowId}`;
}

/** Check if an ID is a merge gate ID. */
export function isMergeGateId(id: string): boolean {
  return id.startsWith('__merge_gate__');
}

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
    const wfId = task.config.workflowId ?? 'unknown';
    if (!groups.has(wfId)) groups.set(wfId, []);
    groups.get(wfId)!.push(task);
  }
  return groups;
}

/** Returns workflow group entries sorted by workflowId; 'unknown' is sorted last. */
export function sortedWorkflowGroups(groups: Map<string, TaskState[]>): [string, TaskState[]][] {
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'unknown') return 1;
    if (b === 'unknown') return -1;
    return a.localeCompare(b);
  });
}
