import { resolve as resolvePath } from 'node:path';

import type { MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import { createDelegatedTaskFeed, trackWorkflow } from './headless-watch.js';

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
  if (command) {
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

export async function tryDelegateQueryUiPerf(
  messageBus: MessageBus,
  reset?: boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | null> {
  return tryDelegateQuery(messageBus, { kind: 'ui-perf', reset }, timeoutMs);
}

export async function tryDelegateQuery(
  messageBus: MessageBus,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | null> {
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    setTimeout(() => reject(DELEGATION_TIMEOUT), timeoutMs);
  });

  try {
    const response = await Promise.race([
      messageBus.request('headless.query', payload),
      timeoutPromise,
    ]) as Record<string, unknown>;
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
  let targetWorkflowId: string | undefined;
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
  targetWorkflowId = response.workflowId;
  const taskFeed = createDelegatedTaskFeed(messageBus, response.tasks, targetWorkflowId);
  await trackWorkflow({
    workflowId: targetWorkflowId,
    loadTasks: taskFeed.loadTasks,
    messageBus,
    waitForApproval: options.waitForApproval,
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: true,
    subscribeToChanges: taskFeed.subscribeToChanges,
  });
  return true;
}
