import type { TaskState, TaskStatus } from './types.js';

export type WorkflowDerivedStatus =
  | 'pending'
  | 'running'
  | 'fixing_with_ai'
  | 'completed'
  | 'failed'
  | 'closed'
  | 'blocked'
  | 'review_ready'
  | 'awaiting_approval'
  | 'stale';

export type WorkflowTaskStatusCounts = Record<TaskStatus, number>;

export interface WorkflowRollupTaskIssue {
  taskId: string;
  description: string;
  status: TaskStatus;
  error?: string;
  protocolErrorCode?: string;
  protocolErrorMessage?: string;
  pendingFixError?: string;
  exitCode?: number;
  completedAt?: string;
  agentSessionId?: string;
  agentName?: string;
  reviewUrl?: string;
  inputPrompt?: string;
}

export interface WorkflowRollup {
  status: WorkflowDerivedStatus;
  countsByStatus: WorkflowTaskStatusCounts;
  failedTasks: WorkflowRollupTaskIssue[];
  fixingTasks: WorkflowRollupTaskIssue[];
  waitingTasks: WorkflowRollupTaskIssue[];
}

export interface WorkflowRollupTaskSummary {
  id: string;
  description: string;
  status: TaskStatus;
  dependencies?: readonly string[];
  execution?: {
    error?: string;
    protocolErrorCode?: string;
    protocolErrorMessage?: string;
    pendingFixError?: string;
    exitCode?: number;
    completedAt?: Date | string;
    agentSessionId?: string;
    agentName?: string;
    reviewUrl?: string;
    inputPrompt?: string;
    isFixingWithAI?: boolean;
  };
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'closed',
  'needs_input',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
];

export function createEmptyWorkflowTaskStatusCounts(): WorkflowTaskStatusCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as WorkflowTaskStatusCounts;
}

export function computeWorkflowStatusFromCounts(
  counts: WorkflowTaskStatusCounts,
): WorkflowDerivedStatus {
  const total = TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  if (total === 0) return 'pending';

  if (counts.fixing_with_ai > 0) return 'fixing_with_ai';
  if (counts.failed > 0) return 'failed';
  if (counts.running > 0) return 'running';
  if (counts.awaiting_approval > 0) return 'awaiting_approval';
  if (counts.review_ready > 0) return 'review_ready';
  if (counts.closed > 0) return 'closed';
  if (counts.blocked > 0 || counts.needs_input > 0) return 'blocked';
  if (counts.pending === total) return 'pending';
  if (counts.pending > 0) return 'running';
  if (counts.completed > 0 && counts.completed + counts.stale === total) return 'completed';
  if (counts.stale === total) return 'stale';

  return 'running';
}

export function hasFailedDependencyPath(
  task: WorkflowRollupTaskSummary,
  tasksById: ReadonlyMap<string, WorkflowRollupTaskSummary>,
  seen: Set<string> = new Set(),
): boolean {
  for (const dependencyId of task.dependencies ?? []) {
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    const dependency = tasksById.get(dependencyId);
    if (!dependency) continue;
    if (dependency.status === 'failed' || dependency.status === 'closed') return true;
    if (hasFailedDependencyPath(dependency, tasksById, seen)) return true;
  }
  return false;
}

function computeWorkflowStatusFromTaskGraph(
  tasks: readonly WorkflowRollupTaskSummary[],
  counts: WorkflowTaskStatusCounts,
): WorkflowDerivedStatus {
  const countedStatus = computeWorkflowStatusFromCounts(counts);
  if (countedStatus !== 'running' || (counts.failed === 0 && counts.closed === 0) || counts.pending === 0) {
    return countedStatus;
  }

  const pendingTasks = tasks.filter((task) => task.status === 'pending');
  if (pendingTasks.length === 0) return countedStatus;

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const allPendingWorkIsBlockedByFailedDependency = pendingTasks.every((task) =>
    hasFailedDependencyPath(task, tasksById),
  );

  return allPendingWorkIsBlockedByFailedDependency ? 'failed' : countedStatus;
}

export function computeWorkflowRollupFromSummaries(
  tasks: readonly WorkflowRollupTaskSummary[],
): WorkflowRollup {
  const counts = createEmptyWorkflowTaskStatusCounts();
  const failedTasks: WorkflowRollupTaskIssue[] = [];
  const fixingTasks: WorkflowRollupTaskIssue[] = [];
  const waitingTasks: WorkflowRollupTaskIssue[] = [];

  for (const task of tasks) {
    counts[task.status] += 1;
    const issue = toRollupIssue(task);

    if (task.status === 'failed') {
      failedTasks.push(issue);
    }
    if (task.status === 'fixing_with_ai' || task.execution?.isFixingWithAI) {
      fixingTasks.push(issue);
    }
    if (
      task.status === 'needs_input' ||
      task.status === 'blocked' ||
      task.status === 'review_ready' ||
      task.status === 'awaiting_approval'
    ) {
      waitingTasks.push(issue);
    }
  }

  return {
    status: computeWorkflowStatusFromTaskGraph(tasks, counts),
    countsByStatus: counts,
    failedTasks,
    fixingTasks,
    waitingTasks,
  };
}

export function computeWorkflowRollupFromCountsAndIssues(
  counts: WorkflowTaskStatusCounts,
  issues: readonly WorkflowRollupTaskSummary[],
): WorkflowRollup {
  const failedTasks: WorkflowRollupTaskIssue[] = [];
  const fixingTasks: WorkflowRollupTaskIssue[] = [];
  const waitingTasks: WorkflowRollupTaskIssue[] = [];

  for (const task of issues) {
    const issue = toRollupIssue(task);
    if (task.status === 'failed') failedTasks.push(issue);
    if (task.status === 'fixing_with_ai' || task.execution?.isFixingWithAI) fixingTasks.push(issue);
    if (
      task.status === 'needs_input' ||
      task.status === 'blocked' ||
      task.status === 'review_ready' ||
      task.status === 'awaiting_approval'
    ) {
      waitingTasks.push(issue);
    }
  }

  return {
    status: computeWorkflowStatusFromCounts(counts),
    countsByStatus: counts,
    failedTasks,
    fixingTasks,
    waitingTasks,
  };
}

export function computeWorkflowRollup(tasks: readonly TaskState[]): WorkflowRollup {
  return computeWorkflowRollupFromSummaries(tasks);
}

function toRollupIssue(task: WorkflowRollupTaskSummary): WorkflowRollupTaskIssue {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status,
    error: task.execution?.error,
    protocolErrorCode: task.execution?.protocolErrorCode,
    protocolErrorMessage: task.execution?.protocolErrorMessage,
    pendingFixError: task.execution?.pendingFixError,
    exitCode: task.execution?.exitCode,
    completedAt: stringifyDate(task.execution?.completedAt),
    agentSessionId: task.execution?.agentSessionId,
    agentName: task.execution?.agentName,
    reviewUrl: task.execution?.reviewUrl,
    inputPrompt: task.execution?.inputPrompt,
  };
}

function stringifyDate(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return value;
}
