import { resolve as resolvePath } from 'node:path';

import { TransportError, TransportErrorCode, type MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import {
  resolveHeadlessTarget,
  type HeadlessTargetLookup,
} from './headless-command-classification.js';
import { createDelegatedTaskFeed, trackWorkflow } from './headless-watch.js';
import {
  formatReviewGateCiRepairResult,
  type ReviewGateCiRepairCommandResult,
} from './review-gate-ci-repair-command.js';

type DelegateTrackingOptions = {
  waitForApproval?: boolean;
  noTrack?: boolean;
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// DelegationOutcome — typed result union for delegation attempts
// ---------------------------------------------------------------------------

export type DelegationOutcome =
  | { kind: 'delegated'; workflowId?: string; tasks?: TaskState[] }
  | { kind: 'timeout' }
  | { kind: 'no-handler' }
  | { kind: 'protocol-error'; message: string };

/** Type guard: returns true when the delegation was accepted by the owner. */
export function isDelegated(outcome: DelegationOutcome): outcome is DelegationOutcome & { kind: 'delegated' } {
  return outcome.kind === 'delegated';
}

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
): Promise<DelegationOutcome> {
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
): Promise<DelegationOutcome> {
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

function delegatedReviewGateCiRepairResult(response: Record<string, unknown>): ReviewGateCiRepairCommandResult | undefined {
  const candidate = response.reviewGateCiRepair;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const result = candidate as Partial<ReviewGateCiRepairCommandResult>;
  if (result.ok !== true) return undefined;
  if (result.decision !== 'queued' && result.decision !== 'skipped' && result.decision !== 'unmapped') {
    return undefined;
  }
  if (typeof result.reason !== 'string') return undefined;
  return candidate as ReviewGateCiRepairCommandResult;
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
): Promise<DelegationOutcome> {
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
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
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
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
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
): Promise<DelegationOutcome> {
  const traceId = (payload as { traceId?: string })?.traceId ?? createTraceId(channel);
  let targetWorkflowId: string | undefined;
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(DELEGATION_TIMEOUT), options.timeoutMs ?? 5_000);
    timeoutHandle.unref?.();
  });

  let raw: unknown;
  try {
    const startedAt = Date.now();
    delegationLog(`${traceId} send channel=${channel} timeoutMs=${options.timeoutMs ?? 5_000}`);
    raw = await Promise.race([
      messageBus.request(channel, payload),
      timeoutPromise,
    ]);
    delegationLog(`${traceId} response channel=${channel} elapsedMs=${Date.now() - startedAt}`);
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) {
      delegationLog(`${traceId} timeout channel=${channel} timeoutMs=${options.timeoutMs ?? 5_000}`);
      return { kind: 'timeout' };
    }
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
      delegationLog(`${traceId} no-handler channel=${channel}`);
      return { kind: 'no-handler' };
    }
    delegationLog(`${traceId} error channel=${channel} ${(err instanceof Error ? err.message : String(err))}`);
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // ── Response-shape validation ──────────────────────────────────────────
  // Owner handlers return one of two shapes:
  //   1. { workflowId: string; tasks: TaskState[] }  — workflow-creating commands
  //   2. { ok: true, ... }                           — mutation commands
  // Anything else is a protocol violation.
  if (raw == null || typeof raw !== 'object') {
    const msg = `expected object response, got ${raw === null ? 'null' : typeof raw}`;
    delegationLog(`${traceId} protocol-error channel=${channel} ${msg}`);
    return { kind: 'protocol-error', message: msg };
  }

  const response = raw as Record<string, unknown>;

  const hasWorkflowId = 'workflowId' in response && typeof response.workflowId === 'string';
  const hasOk = 'ok' in response && response.ok === true;

  if (hasWorkflowId) {
    if (!Array.isArray(response.tasks)) {
      const msg = `response has workflowId but tasks is ${typeof response.tasks}, expected array`;
      delegationLog(`${traceId} protocol-error channel=${channel} ${msg}`);
      return { kind: 'protocol-error', message: msg };
    }
  } else if (!hasOk) {
    const keys = Object.keys(response).join(', ');
    const msg = `response has neither workflowId (string) nor ok (true); keys: [${keys}]`;
    delegationLog(`${traceId} protocol-error channel=${channel} ${msg}`);
    return { kind: 'protocol-error', message: msg };
  }

  if (hasWorkflowId) {
    targetWorkflowId = response.workflowId as string;
    process.stdout.write(`Delegated to owner — workflow: ${targetWorkflowId}\n`);
  } else {
    process.stdout.write('Delegated to owner\n');
  }
  const repairResult = delegatedReviewGateCiRepairResult(response);
  if (repairResult) {
    process.stdout.write(`${formatReviewGateCiRepairResult(repairResult)}\n`);
  }

  const outcome: DelegationOutcome = hasWorkflowId
    ? { kind: 'delegated', workflowId: response.workflowId as string, tasks: response.tasks as TaskState[] }
    : { kind: 'delegated' };

  if (options.noTrack) {
    process.stdout.write('--no-track enabled: delegated submission accepted; exiting without tracking.\n');
    return outcome;
  }

  if (!hasWorkflowId || !Array.isArray(response.tasks)) {
    return outcome;
  }
  targetWorkflowId = response.workflowId as string;
  const taskFeed = createDelegatedTaskFeed(messageBus, response.tasks as TaskState[], targetWorkflowId);
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
  return outcome;
}
