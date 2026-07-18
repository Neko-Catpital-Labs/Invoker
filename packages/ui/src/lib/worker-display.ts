import type {
  TaskState,
  WorkerActionStatus,
  WorkerActionSummary,
  WorkerStatusEntry,
  WorkflowMeta,
} from '../types.js';

export interface WorkerDisplayCopy {
  readonly name: string;
  readonly idleText: string;
  readonly noActionText: string;
}

export interface WorkerActionTargetContext {
  readonly task: TaskState | null;
  readonly taskTitle: string;
  readonly workflowId: string | undefined;
  readonly workflowName: string | undefined;
}

export const ACTIVE_WORKER_ACTION_STATUSES: ReadonlySet<WorkerActionStatus> = new Set<WorkerActionStatus>([
  'queued',
  'pending',
  'running',
  'needs_input',
  'review_ready',
]);

export function formatWorkerValue(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function displayWorkerTaskId(taskId: string): string {
  if (taskId.startsWith('__merge__')) return 'merge gate';
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
}

export function resolveWorkerActionTarget(
  action: WorkerActionSummary,
  tasks: Map<string, TaskState>,
  workflows?: Map<string, WorkflowMeta>,
): WorkerActionTargetContext {
  const task = action.taskId ? tasks.get(action.taskId) ?? null : null;
  const workflowId = action.workflowId ?? task?.config.workflowId;
  const workflowName = workflowId
    ? workflows?.get(workflowId)?.name ?? workflowId
    : undefined;

  let taskTitle: string;
  if (task?.description) {
    taskTitle = task.description;
  } else if (action.taskId) {
    taskTitle = displayWorkerTaskId(action.taskId);
  } else {
    taskTitle = `${formatWorkerValue(action.subjectType)} ${action.subjectId}`;
  }

  return {
    task,
    taskTitle,
    workflowId,
    workflowName,
  };
}

export function getWorkerDisplayCopy(kind: string): WorkerDisplayCopy {
  if (kind === 'autofix') {
    return {
      name: 'Autofix',
      idleText: 'Idle. Waiting for failed tasks that still have retry budget.',
      noActionText: 'No autofix actions recorded yet.',
    };
  }
  if (kind === 'pr-status') {
    return {
      name: 'PR status',
      idleText: 'Idle. Polls review-gate PR status every minute; it does not create queue tasks.',
      noActionText: 'No persisted PR status actions. This worker updates review gates directly.',
    };
  }
  if (kind === 'pr-summary-refresh') {
    return {
      name: 'PR summary refresh',
      idleText: 'Idle. Refreshes published PR bodies when Invoker pipeline actions change.',
      noActionText: 'No PR summary refresh actions recorded yet.',
    };
  }
  if (kind === 'ci-failure') {
    return {
      name: 'CI failure repair',
      idleText: 'Idle. Waiting for review-gate CI failure events.',
      noActionText: 'No CI repair actions recorded yet.',
    };
  }
  if (kind === 'pr-ci-failure-scan') {
    return {
      name: 'PR CI scan',
      idleText: 'Idle. Scans mapped PRs for failing CI and queues repairs.',
      noActionText: 'No PR CI scan runs recorded yet.',
    };
  }
  if (kind === 'e2e-autofix') {
    return {
      name: 'Daily e2e auto-fix',
      idleText: 'Idle. Runs the extended e2e battery on a schedule and opens one fix PR per failing suite.',
      noActionText: 'No e2e auto-fix runs recorded yet.',
    };
  }
  return {
    name: formatWorkerValue(kind),
    idleText: 'Idle. Waiting for worker-owned work.',
    noActionText: 'No worker actions recorded yet.',
  };
}

export function getActiveWorkerActions(worker: WorkerStatusEntry): WorkerActionSummary[] {
  return worker.recentActions.filter((action) => ACTIVE_WORKER_ACTION_STATUSES.has(action.status));
}

export function getActiveWorkerAction(worker: WorkerStatusEntry): WorkerActionSummary | undefined {
  return getActiveWorkerActions(worker)[0];
}

export function countActiveWorkerActions(workers: readonly WorkerStatusEntry[]): number {
  return workers.reduce((count, worker) => count + getActiveWorkerActions(worker).length, 0);
}
