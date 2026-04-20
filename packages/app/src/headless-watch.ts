import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import type { TaskConfig, TaskDelta, TaskState } from '@invoker/workflow-core';

import { formatTaskStatus, formatWorkflowStatus } from './formatter.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface TrackWorkflowOptions {
  workflowId: string;
  loadTasks: () => TaskState[] | Promise<TaskState[]>;
  messageBus?: MessageBus;
  subscribeToChanges?: (notify: () => void) => () => void;
  waitForApproval?: boolean;
  hasBackgroundWork?: () => boolean;
  printSnapshot?: boolean;
  printSummary?: boolean;
  printTaskOutput?: boolean;
  allowSignals?: boolean;
  setExitCodeOnFailure?: boolean;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export interface TrackWorkflowResult {
  interrupted: boolean;
  tasks: TaskState[];
  status: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
  reviewUrl?: string;
}

export interface DelegatedTaskFeed {
  loadTasks: () => TaskState[];
  subscribeToChanges: (notify: () => void) => () => void;
}

export function createDelegatedTaskFeed(
  messageBus: MessageBus,
  initialTasks: TaskState[],
  workflowId?: string,
): DelegatedTaskFeed {
  const tasks = new Map<string, TaskState>(initialTasks.map((task) => [task.id, task]));

  return {
    loadTasks: () => Array.from(tasks.values()).filter((task) => (
      !workflowId || task.config.workflowId === workflowId
    )),
    subscribeToChanges: (notify) => {
      const deltaUnsub = messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
        if (delta.type === 'created') {
          const task = delta.task;
          if (workflowId && task.config.workflowId !== workflowId) return;
          tasks.set(task.id, task);
          notify();
          return;
        }

        if (delta.type === 'updated') {
          const existing = tasks.get(delta.taskId);
          if (!existing) return;
          const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
          const updated: TaskState = {
            ...existing,
            ...topLevel,
            config: { ...existing.config, ...cfgChanges } as TaskConfig,
            execution: { ...existing.execution, ...execChanges },
          };
          tasks.set(delta.taskId, updated);
          notify();
          return;
        }

        if (delta.type === 'removed') {
          if (!tasks.delete(delta.taskId)) return;
          notify();
        }
      });

      return () => deltaUnsub();
    },
  };
}

export async function trackWorkflow(options: TrackWorkflowOptions): Promise<TrackWorkflowResult> {
  const printSnapshot = options.printSnapshot ?? false;
  const printSummary = options.printSummary ?? true;
  const printTaskOutput = options.printTaskOutput ?? false;
  const allowSignals = options.allowSignals ?? false;
  const setExitCodeOnFailure = options.setExitCodeOnFailure ?? printSummary;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxWaitMs = options.maxWaitMs;
  const taskLineById = new Map<string, string>();
  let tasks: TaskState[] = [];
  let interrupted = false;

  let wake: (() => void) | null = null;
  let wakePromise: Promise<void> | null = null;
  const signalWake = (): void => {
    wake?.();
  };
  const nextWake = (): Promise<void> => {
    wakePromise ??= new Promise<void>((resolve) => {
      wake = () => {
        wake = null;
        wakePromise = null;
        resolve();
      };
    });
    return wakePromise;
  };

  const refresh = async (forceSnapshot = false): Promise<void> => {
    tasks = filterWorkflowTasks(await options.loadTasks(), options.workflowId);
    const visibleTasks = tasks;
    const currentIds = new Set(visibleTasks.map((task) => task.id));
    for (const task of visibleTasks) {
      const line = formatTaskStatus(task);
      const previous = taskLineById.get(task.id);
      if (forceSnapshot || previous !== line) {
        process.stdout.write(line + '\n');
      }
      taskLineById.set(task.id, line);
    }
    for (const taskId of Array.from(taskLineById.keys())) {
      if (!currentIds.has(taskId)) {
        taskLineById.delete(taskId);
      }
    }
  };

  const deltaUnsub = options.subscribeToChanges
    ? options.subscribeToChanges(signalWake)
    : options.messageBus?.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
      const deltaWorkflowId = delta.type === 'created'
        ? delta.task.config.workflowId
        : delta.type === 'updated'
          ? tasks.find((task) => task.id === delta.taskId)?.config.workflowId
          : undefined;
      if (!deltaWorkflowId || deltaWorkflowId === options.workflowId) {
        signalWake();
      }
    }) ?? (() => {});

  const outputUnsub = printTaskOutput
    ? options.messageBus?.subscribe<{ taskId: string; data: string }>(Channels.TASK_OUTPUT, ({ taskId, data }) => {
      if (taskBelongsToWorkflow(taskId, options.workflowId)) {
        process.stdout.write(`${DIM}[${taskId}]${RESET} ${data}`);
      }
    }) ?? (() => {})
    : (() => {});

  const signalHandler = (): void => {
    interrupted = true;
    signalWake();
  };
  if (allowSignals) {
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
  }

  const startedAt = Date.now();

  try {
    await refresh(printSnapshot);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (workflowHasSettled(tasks, options.waitForApproval, options.hasBackgroundWork)) {
        break;
      }
      if (interrupted) {
        break;
      }
      if (typeof maxWaitMs === 'number' && Date.now() - startedAt >= maxWaitMs) {
        break;
      }

      await Promise.race([
        nextWake(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollIntervalMs);
          timer.unref?.();
        }),
      ]);

      await refresh(false);
    }
  } finally {
    deltaUnsub();
    outputUnsub();
    if (allowSignals) {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }
  }

  const result = summarizeWorkflowTasks(tasks);
  if (printSummary) {
    process.stdout.write(`\n${formatWorkflowStatus(result.status)}\n`);
    if (result.reviewUrl) {
      process.stdout.write(`\nPull Request: ${result.reviewUrl}\n`);
    }
  }
  if (setExitCodeOnFailure && result.status.failed > 0) {
    process.exitCode = 1;
  }

  return {
    interrupted,
    tasks,
    status: result.status,
    reviewUrl: result.reviewUrl,
  };
}

function filterWorkflowTasks(tasks: TaskState[], workflowId: string): TaskState[] {
  return tasks.filter((task) => task.config.workflowId === workflowId);
}

function taskBelongsToWorkflow(taskId: string, workflowId: string): boolean {
  return taskId === workflowId || taskId.startsWith(`${workflowId}/`);
}

function workflowHasSettled(
  tasks: TaskState[],
  waitForApproval?: boolean,
  hasBackgroundWork?: () => boolean,
): boolean {
  const settledStatuses = waitForApproval
    ? new Set(['completed', 'failed', 'needs_input', 'blocked', 'stale'])
    : new Set(['completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'blocked', 'stale']);
  const allSettled = tasks.length > 0 && tasks.every((task) => settledStatuses.has(task.status));
  if (allSettled && !hasBackgroundWork?.()) {
    return true;
  }

  const noneRunning = !tasks.some((task) => task.status === 'running' || task.status === 'fixing_with_ai');
  const hasHumanBlocked = tasks.some((task) => settledStatuses.has(task.status) && task.status !== 'completed');
  return noneRunning && hasHumanBlocked && !hasBackgroundWork?.();
}

function summarizeWorkflowTasks(tasks: TaskState[]): Pick<TrackWorkflowResult, 'status' | 'reviewUrl'> {
  const status = {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    running: tasks.filter((task) => task.status === 'running' || task.status === 'fixing_with_ai').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
  };
  const reviewUrl = tasks.find((task) => task.config.isMergeNode)?.execution.reviewUrl;
  return { status, reviewUrl };
}
