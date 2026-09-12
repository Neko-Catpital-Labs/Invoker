export type WorkflowTaskSnapshot = {
  id: string;
  status: string;
  description?: string;
  reviewUrl?: string;
};

export type WorkflowStatusSummary = {
  total: number;
  completed: number;
  failed: number;
  closed: number;
  skipped?: number;
  running: number;
  pending: number;
  awaitingApproval: number;
  blocked: number;
};

export type WorkflowWaitResult = {
  workflowId: string;
  settled: boolean;
  timedOut: boolean;
  status: WorkflowStatusSummary;
  reviewUrl?: string;
  tasks: WorkflowTaskSnapshot[];
};

const ACTIVE = new Set(['running', 'fixing_with_ai', 'queued']);

export function summarizeTaskStatuses(tasks: WorkflowTaskSnapshot[]): WorkflowStatusSummary {
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    closed: tasks.filter((task) => task.status === 'closed').length,
    skipped: tasks.filter((task) => task.status === 'skipped').length,
    running: tasks.filter((task) => task.status === 'running' || task.status === 'fixing_with_ai').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    awaitingApproval: tasks.filter((task) => task.status === 'awaiting_approval' || task.status === 'review_ready').length,
    blocked: tasks.filter((task) => task.status === 'blocked' || task.status === 'needs_input' || task.status === 'stale').length,
  };
}

export function workflowTasksSettled(tasks: WorkflowTaskSnapshot[]): boolean {
  if (tasks.length === 0) return false;
  const settled = new Set([
    'completed',
    'failed',
    'closed',
    'skipped',
    'needs_input',
    'awaiting_approval',
    'review_ready',
    'blocked',
    'stale',
  ]);
  if (tasks.every((task) => settled.has(task.status))) {
    return true;
  }
  const noneActive = !tasks.some((task) => ACTIVE.has(task.status));
  const hasHumanGate = tasks.some((task) => settled.has(task.status) && task.status !== 'completed');
  return noneActive && hasHumanGate;
}

export function pickReviewUrl(tasks: WorkflowTaskSnapshot[]): string | undefined {
  return tasks.find((task) => typeof task.reviewUrl === 'string' && task.reviewUrl.length > 0)?.reviewUrl;
}

export function normalizeTaskSnapshots(raw: unknown): WorkflowTaskSnapshot[] {
  if (!Array.isArray(raw)) {
    throw new Error('Expected a JSON array of tasks');
  }
  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Expected each task to be an object');
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const status = typeof row.status === 'string' ? row.status : '';
    if (!id || !status) {
      throw new Error('Each task must include id and status');
    }
    const description = typeof row.description === 'string' ? row.description : undefined;
    const execution = row.execution && typeof row.execution === 'object'
      ? row.execution as Record<string, unknown>
      : undefined;
    const reviewUrl = typeof execution?.reviewUrl === 'string' ? execution.reviewUrl : undefined;
    return { id, status, description, reviewUrl };
  });
}

export function normalizeWorkflowSnapshot(raw: unknown, workflowId: string): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const match = raw.find((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === workflowId);
    if (!match || typeof match !== 'object') {
      throw new Error(`Workflow "${workflowId}" was not found`);
    }
    return match as Record<string, unknown>;
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Workflow "${workflowId}" was not found`);
  }
  const row = raw as Record<string, unknown>;
  if (row.id !== workflowId) {
    throw new Error(`Workflow "${workflowId}" was not found`);
  }
  return row;
}

export async function waitForWorkflowTasks(options: {
  workflowId: string;
  loadTasks: () => Promise<WorkflowTaskSnapshot[]>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WorkflowWaitResult> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const startedAt = Date.now();
  let tasks = await options.loadTasks();
  let settled = workflowTasksSettled(tasks);
  let timedOut = false;

  while (!settled) {
    if (Date.now() - startedAt >= maxWaitMs) {
      timedOut = true;
      break;
    }
    await sleep(pollIntervalMs);
    tasks = await options.loadTasks();
    settled = workflowTasksSettled(tasks);
  }

  return {
    workflowId: options.workflowId,
    settled,
    timedOut,
    status: summarizeTaskStatuses(tasks),
    reviewUrl: pickReviewUrl(tasks),
    tasks,
  };
}
