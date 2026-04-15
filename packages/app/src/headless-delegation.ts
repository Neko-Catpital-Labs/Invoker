import { resolve as resolvePath } from 'node:path';

import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import type { TaskConfig, TaskDelta, TaskState } from '@invoker/workflow-core';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

type DelegateTrackingOptions = {
  waitForApproval?: boolean;
  noTrack?: boolean;
  timeoutMs?: number;
};

export async function tryDelegateRun(
  planPath: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  return tryDelegate(
    'headless.run',
    { planPath: resolvePath(planPath) },
    messageBus,
    { waitForApproval, noTrack, timeoutMs: 5_000 },
  );
}

export async function tryDelegateResume(
  workflowId: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  return tryDelegate(
    'headless.resume',
    { workflowId },
    messageBus,
    { waitForApproval, noTrack, timeoutMs: 5_000 },
  );
}

export function delegationTimeoutMs(args: string[]): number {
  const command = args[0] ?? '';
  const target = args[1] ?? '';
  const isWorkflowId = /^wf-[^/]+$/.test(target);

  if (
    command === 'rebase' ||
    command === 'rebase-and-retry' ||
    command === 'recreate' ||
    command === 'restart' ||
    command === 'set' ||
    command === 'fix' ||
    command === 'resolve-conflict'
  ) {
    return 900_000;
  }
  if (isWorkflowId) {
    return 900_000;
  }
  return 15_000;
}

export async function tryDelegateExec(
  args: string[],
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
  timeoutMs: number = delegationTimeoutMs(args),
): Promise<boolean> {
  return tryDelegate(
    'headless.exec',
    { args, waitForApproval, noTrack },
    messageBus,
    { waitForApproval, noTrack, timeoutMs },
  );
}

export async function tryPingHeadlessOwner(
  messageBus: MessageBus,
  timeoutMs = 1_000,
): Promise<{ ownerId?: string; mode?: string } | null> {
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    setTimeout(() => reject(DELEGATION_TIMEOUT), timeoutMs);
  });

  try {
    const response = await Promise.race([
      messageBus.request('headless.owner-ping', {}),
      timeoutPromise,
    ]) as { ownerId?: string; mode?: string };
    return response;
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) return null;
    if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
      return null;
    }
    throw err;
  }
}

async function tryDelegate(
  channel: string,
  payload: unknown,
  messageBus: MessageBus,
  options: DelegateTrackingOptions,
): Promise<boolean> {
  const { formatTaskStatus } = await import('./formatter.js');
  const tasks = new Map<string, TaskState>();
  let targetWorkflowId: string | undefined;

  const deltaUnsub = messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'created') {
      const task = delta.task;
      if (!targetWorkflowId || task.config.workflowId === targetWorkflowId) {
        tasks.set(task.id, task);
        process.stdout.write(formatTaskStatus(task) + '\n');
      }
    } else if (delta.type === 'updated') {
      const existing = tasks.get(delta.taskId);
      if (existing) {
        const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
        const updated: TaskState = {
          ...existing,
          ...topLevel,
          config: { ...existing.config, ...cfgChanges } as TaskConfig,
          execution: { ...existing.execution, ...execChanges },
        };
        tasks.set(delta.taskId, updated);
        process.stdout.write(formatTaskStatus(updated) + '\n');
      }
    } else if (delta.type === 'removed') {
      tasks.delete(delta.taskId);
    }
  });

  const outputUnsub = messageBus.subscribe<{ taskId: string; data: string }>(
    Channels.TASK_OUTPUT,
    ({ taskId, data }) => {
      if (tasks.has(taskId)) {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      }
    },
  );

  try {
    const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
    const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
      setTimeout(() => reject(DELEGATION_TIMEOUT), options.timeoutMs ?? 5_000);
    });

    let response: { workflowId: string; tasks: TaskState[] } | { ok: true };
    try {
      response = await Promise.race([
        messageBus.request<typeof payload, typeof response>(channel, payload),
        timeoutPromise,
      ]) as { workflowId: string; tasks: TaskState[] } | { ok: true };
    } catch (err) {
      if (err === DELEGATION_TIMEOUT) {
        return false;
      }
      if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
        return false;
      }
      throw err;
    }

    if ('workflowId' in response) {
      targetWorkflowId = response.workflowId;
      process.stdout.write(`Delegated to owner — workflow: ${targetWorkflowId}\n`);
    } else {
      process.stdout.write('Delegated to owner\n');
    }

    if (options.noTrack) {
      process.stdout.write('[headless] --no-track enabled: delegated submission accepted; exiting without tracking.\n');
      return true;
    }

    if (!('workflowId' in response) || !Array.isArray(response.tasks)) {
      return true;
    }

    for (const task of response.tasks) {
      if (!tasks.has(task.id)) {
        tasks.set(task.id, task);
      }
    }

    await waitForDelegatedSettlement(tasks, targetWorkflowId, options.waitForApproval);

    const taskArray = Array.from(tasks.values());
    const completedCount = taskArray.filter((t) => t.status === 'completed').length;
    const failedCount = taskArray.filter((t) => t.status === 'failed').length;
    process.stdout.write(`\n${BOLD}Summary:${RESET} ${completedCount} completed, ${failedCount} failed\n`);

    const mergeTask = taskArray.find((t) => t.config.isMergeNode);
    if (mergeTask?.execution?.reviewUrl) {
      process.stdout.write(`\nPull Request: ${mergeTask.execution.reviewUrl}\n`);
    }
    if (failedCount > 0) {
      process.exitCode = 1;
    }
    return true;
  } finally {
    deltaUnsub();
    outputUnsub();
  }
}

async function waitForDelegatedSettlement(
  tasks: Map<string, TaskState>,
  workflowId: string | undefined,
  waitForApproval?: boolean,
): Promise<void> {
  const pollIntervalMs = 100;
  const settledStatuses = ['failed', 'awaiting_approval', 'review_ready', 'needs_input'];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const taskArray = Array.from(tasks.values()).filter((task) => (
      !workflowId || task.config.workflowId === workflowId
    ));

    if (taskArray.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const running = taskArray.some(
      (task) => task.status === 'running' || task.status === 'fixing_with_ai',
    );
    const pending = taskArray.some((task) => task.status === 'pending');
    const blockingReview = taskArray.some(
      (task) => task.config.isMergeNode && (task.status === 'review_ready' || task.status === 'awaiting_approval'),
    );

    if (!running && !pending) {
      if (!waitForApproval) return;
      if (!blockingReview) return;
    }

    const noneRunning = !taskArray.some(
      (task) => task.status === 'running' || task.status === 'fixing_with_ai',
    );
    const hasHumanBlocked = taskArray.some(
      (task) => settledStatuses.includes(task.status) && task.status !== 'completed',
    );
    if (noneRunning && hasHumanBlocked) return;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
