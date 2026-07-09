import type { WorkerActionStatus, WorkerActionSummary, WorkerStatusEntry } from '../types.js';

export interface WorkerDisplayCopy {
  readonly name: string;
  readonly idleText: string;
  readonly noActionText: string;
}

export const ACTIVE_WORKER_ACTION_STATUSES: ReadonlySet<WorkerActionStatus> = new Set<WorkerActionStatus>([
  'queued',
  'pending',
  'running',
  'needs_input',
  'review_ready',
]);

export function formatWorkerValue(value: string): string {
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
  if (kind === 'ci-failure') {
    return {
      name: 'CI failure repair',
      idleText: 'Idle. Waiting for review-gate CI failure events.',
      noActionText: 'No CI repair actions recorded yet.',
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
