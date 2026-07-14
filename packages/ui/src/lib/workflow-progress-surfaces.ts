import type { QueueStatus } from '@invoker/contracts';
import type { TaskState, TaskStatus, WorkflowMeta, WorkflowStatus } from '../types.js';

export type SidebarSurface = 'home' | 'planning' | 'workflows' | 'attention' | 'running' | 'workers';

export interface WorkflowListEntry {
  workflow: WorkflowMeta;
  taskCount: number;
}

export interface WorkflowTaskEntry {
  task: TaskState;
  workflow: WorkflowMeta | null;
}

const WORKFLOW_STATUS_PRIORITY: Record<WorkflowStatus, number> = {
  failed: 0,
  blocked: 1,
  awaiting_approval: 2,
  review_ready: 3,
  running: 4,
  fixing_with_ai: 5,
  pending: 6,
  stale: 7,
  completed: 8,
  closed: 9,
};

const ATTENTION_STATUS_PRIORITY: Partial<Record<TaskStatus, number>> = {
  failed: 0,
  awaiting_approval: 1,
  review_ready: 2,
  blocked: 3,
  needs_input: 4,
};

const RUNNING_TASK_STATUS: Partial<Record<TaskStatus, true>> = {
  running: true,
  fixing_with_ai: true,
};

const ATTENTION_TASK_STATUS: Partial<Record<TaskStatus, true>> = {
  failed: true,
  blocked: true,
  needs_input: true,
  awaiting_approval: true,
  review_ready: true,
};

function compareTimestamps(a?: string, b?: string): number {
  const aTime = a ? Date.parse(a) : Number.NaN;
  const bTime = b ? Date.parse(b) : Number.NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }
  if (Number.isFinite(aTime)) return -1;
  if (Number.isFinite(bTime)) return 1;
  return 0;
}

export function formatWorkflowStatus(status: WorkflowStatus): string {
  return status.replaceAll('_', ' ');
}

export function formatTaskStatus(status: TaskStatus): string {
  return status.replaceAll('_', ' ');
}

export function isAttentionTask(task: TaskState): boolean {
  return ATTENTION_TASK_STATUS[task.status] === true;
}

export function isRunningTask(task: TaskState): boolean {
  return RUNNING_TASK_STATUS[task.status] === true;
}

export function getWorkflowTaskCounts(tasks: Map<string, TaskState>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks.values()) {
    const workflowId = task.config.workflowId;
    if (!workflowId) continue;
    counts.set(workflowId, (counts.get(workflowId) ?? 0) + 1);
  }
  return counts;
}

export function getSortedWorkflows(
  workflows: Map<string, WorkflowMeta>,
  tasks: Map<string, TaskState>,
): WorkflowListEntry[] {
  const taskCounts = getWorkflowTaskCounts(tasks);
  return [...workflows.values()]
    .sort((a, b) => {
      const priority = (WORKFLOW_STATUS_PRIORITY[a.status] ?? 99) - (WORKFLOW_STATUS_PRIORITY[b.status] ?? 99);
      if (priority !== 0) return priority;
      const timestampOrder = compareTimestamps(a.updatedAt ?? a.createdAt, b.updatedAt ?? b.createdAt);
      if (timestampOrder !== 0) return timestampOrder;
      return a.name.localeCompare(b.name);
    })
    .map((workflow) => ({
      workflow,
      taskCount: taskCounts.get(workflow.id) ?? 0,
    }));
}

export function getAttentionTaskEntries(
  tasks: Map<string, TaskState>,
  workflows: Map<string, WorkflowMeta>,
  extraTaskIds?: Set<string>,
): WorkflowTaskEntry[] {
  const baseEntries = [...tasks.values()]
    .filter(isAttentionTask)
    .sort((a, b) => {
      const priority = (ATTENTION_STATUS_PRIORITY[a.status] ?? 99) - (ATTENTION_STATUS_PRIORITY[b.status] ?? 99);
      if (priority !== 0) return priority;
      const workflowA = a.config.workflowId ? workflows.get(a.config.workflowId)?.name ?? a.config.workflowId : '';
      const workflowB = b.config.workflowId ? workflows.get(b.config.workflowId)?.name ?? b.config.workflowId : '';
      if (workflowA !== workflowB) return workflowA.localeCompare(workflowB);
      return (a.description || a.id).localeCompare(b.description || b.id);
    })
    .map((task) => ({
      task,
      workflow: task.config.workflowId ? workflows.get(task.config.workflowId) ?? null : null,
    }));

  if (!extraTaskIds || extraTaskIds.size === 0) return baseEntries;

  const existingIds = new Set(baseEntries.map((entry) => entry.task.id));
  const extraEntries = [...extraTaskIds]
    .filter((id) => !existingIds.has(id))
    .map((id) => tasks.get(id))
    .filter((task): task is TaskState => Boolean(task))
    .map((task) => ({
      task,
      workflow: task.config.workflowId ? workflows.get(task.config.workflowId) ?? null : null,
    }));

  return [...baseEntries, ...extraEntries];
}

export function getRunningTaskEntries(
  tasks: Map<string, TaskState>,
  workflows: Map<string, WorkflowMeta>,
  queueStatus: QueueStatus | null,
): WorkflowTaskEntry[] {
  const orderedTasks: TaskState[] = [];
  const includedTaskIds = new Set<string>();
  if (queueStatus?.running.length) {
    for (const { taskId } of queueStatus.running) {
      const task = tasks.get(taskId);
      if (!task || includedTaskIds.has(task.id)) continue;
      orderedTasks.push(task);
      includedTaskIds.add(task.id);
    }
  }
  for (const task of [...tasks.values()]
    .filter(isRunningTask)
    .sort((a, b) => (a.description || a.id).localeCompare(b.description || b.id))) {
    if (includedTaskIds.has(task.id)) continue;
    orderedTasks.push(task);
  }

  return orderedTasks.map((task) => ({
    task,
    workflow: task.config.workflowId ? workflows.get(task.config.workflowId) ?? null : null,
  }));
}
