import { resolve as resolvePath } from 'node:path';

import type { MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import {
  resolveHeadlessTarget,
  type HeadlessTargetLookup,
} from './headless-command-classification.js';
import { createDelegatedTaskFeed, trackWorkflow } from './headless-watch.js';

type DelegateTrackingOptions = {
  waitForApproval?: boolean;
  noTrack?: boolean;
  timeoutMs?: number;
};

function delegationLog(message: string): void {
  process.stderr.write(`[delegation] ${message}\n`);
}

function createTraceId(channel: string): string {
  return `${channel}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

export async function tryDelegateRun(
  planPath: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
  timeoutMs?: number,
): Promise<boolean> {
  const traceId = createTraceId('headless.run');
  return tryDelegate(
    'headless.run',
    { planPath: resolvePath(planPath), traceId },
    messageBus,
    { waitForApproval, noTrack, timeoutMs: timeoutMs ?? 5_000 },
  );
}

export async function tryDelegateResume(
  workflowId: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
  timeoutMs?: number,
): Promise<boolean> {
  const traceId = createTraceId('headless.resume');
  return tryDelegate(
    'headless.resume',
    { workflowId, traceId },
    messageBus,
    { waitForApproval, noTrack, timeoutMs: timeoutMs ?? 5_000 },
  );
}

function usesExtendedDelegationTimeout(command: string): boolean {
  return command === 'rebase' || command === 'rebase-and-retry' || command === 'recreate-with-rebase' || command === 'restart';
}

function looksLikeWorkflowId(target: unknown): boolean {
  return /^wf-[^/]+$/.test(String(target ?? ''));
}

export function delegationTimeoutMs(
  args: string[],
  targetLookup: HeadlessTargetLookup,
): number {
  const command = args[0] ?? '';
  if (!usesExtendedDelegationTimeout(command)) {
    return 5_000;
  }

  const resolvedTarget = resolveHeadlessTarget(args[1], targetLookup);
  if (resolvedTarget.kind === 'workflow') {
    return 60_000;
  }
  return 5_000;
}

export async function resolveDelegationTimeoutMs(args: string[]): Promise<number> {
  const command = args[0] ?? '';
  if (!usesExtendedDelegationTimeout(command)) {
    return 5_000;
  }
  return looksLikeWorkflowId(args[1]) ? 60_000 : 5_000;
}

export async function tryDelegateExec(
  args: string[],
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
  timeoutMs?: number,
): Promise<boolean> {
  const resolvedTimeoutMs = timeoutMs ?? await resolveDelegationTimeoutMs(args);
  const traceId = createTraceId('headless.exec');
  return tryDelegate(
    'headless.exec',
    { args, waitForApproval, noTrack, traceId },
    messageBus,
    { waitForApproval, noTrack, timeoutMs: resolvedTimeoutMs },
  );
}

export async function tryPingHeadlessOwner(
  messageBus: MessageBus,
  timeoutMs = 1_000,
): Promise<{ ownerId?: string; mode?: string } | null> {
  const traceId = createTraceId('headless.owner-ping');
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(DELEGATION_TIMEOUT), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const startedAt = Date.now();
    delegationLog(`${traceId} send timeoutMs=${timeoutMs}`);
    const response = await Promise.race([
      messageBus.request('headless.owner-ping', {}),
      timeoutPromise,
    ]) as { ownerId?: string; mode?: string } | null;
    if (!response || typeof response !== 'object') {
      delegationLog(`${traceId} response elapsedMs=${Date.now() - startedAt} ownerId=<missing> mode=<missing>`);
      return null;
    }
    delegationLog(
      `${traceId} response elapsedMs=${Date.now() - startedAt} ownerId=${response.ownerId ?? '<missing>'} mode=${response.mode ?? '<missing>'}`,
    );
    return response;
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) {
      delegationLog(`${traceId} timeout timeoutMs=${timeoutMs}`);
      return null;
    }
    if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
      delegationLog(`${traceId} no-handler`);
      return null;
    }
    delegationLog(`${traceId} error ${(err instanceof Error ? err.message : String(err))}`);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
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
  const traceId = createTraceId('headless.query');
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(DELEGATION_TIMEOUT), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const startedAt = Date.now();
    delegationLog(`${traceId} send payload=${JSON.stringify(payload)} timeoutMs=${timeoutMs}`);
    const response = await Promise.race([
      messageBus.request('headless.query', payload),
      timeoutPromise,
    ]) as Record<string, unknown>;
    delegationLog(`${traceId} response elapsedMs=${Date.now() - startedAt}`);
    return response;
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) {
      delegationLog(`${traceId} timeout timeoutMs=${timeoutMs}`);
      return null;
    }
    if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
      delegationLog(`${traceId} no-handler`);
      return null;
    }
    delegationLog(`${traceId} error ${(err instanceof Error ? err.message : String(err))}`);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function tryDelegate(
  channel: string,
  payload: unknown,
  messageBus: MessageBus,
  options: DelegateTrackingOptions,
): Promise<boolean> {
  const traceId = (payload as { traceId?: string })?.traceId ?? createTraceId(channel);
  let targetWorkflowId: string | undefined;
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(DELEGATION_TIMEOUT), options.timeoutMs ?? 5_000);
    timeoutHandle.unref?.();
  });

  let response: { workflowId: string; tasks: TaskState[] } | { ok: true };
  try {
    const startedAt = Date.now();
    delegationLog(`${traceId} send channel=${channel} timeoutMs=${options.timeoutMs ?? 5_000}`);
    response = await Promise.race([
      messageBus.request<typeof payload, typeof response>(channel, payload),
      timeoutPromise,
    ]) as { workflowId: string; tasks: TaskState[] } | { ok: true };
    delegationLog(`${traceId} response channel=${channel} elapsedMs=${Date.now() - startedAt}`);
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) {
      delegationLog(`${traceId} timeout channel=${channel} timeoutMs=${options.timeoutMs ?? 5_000}`);
      return false;
    }
    if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
      delegationLog(`${traceId} no-handler channel=${channel}`);
      return false;
    }
    delegationLog(`${traceId} error channel=${channel} ${(err instanceof Error ? err.message : String(err))}`);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if ('workflowId' in response) {
    targetWorkflowId = response.workflowId;
    process.stdout.write(`Delegated to owner — workflow: ${targetWorkflowId}\n`);
  } else {
    process.stdout.write('Delegated to owner\n');
  }

  if (options.noTrack) {
    process.stdout.write('--no-track enabled: delegated submission accepted; exiting without tracking.\n');
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
