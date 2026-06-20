/**
 * Shared runtime contract for long-running Invoker workers.
 *
 * A worker runtime is the reusable boundary that owns a worker's lifecycle:
 *   - identity   — a stable `kind` plus a unique `instanceId` per process
 *   - wakeup     — `wake()` requests an immediate tick outside the poll cadence
 *   - poll       — an optional periodic timer drives ticks on an interval
 *   - coalesce   — overlapping wake/poll requests collapse into a single
 *                  follow-up tick; ticks never run concurrently
 *   - shutdown   — `stop()` is deterministic and idempotent: it clears the
 *                  timer, drops SIGINT/SIGTERM handlers, and awaits the
 *                  in-flight tick before resolving
 *
 * The auto-fix recovery worker built on top of this runtime is a reconcile
 * loop over persisted task state. It discovers eligible failed tasks and
 * submits the normal fix command route; it never mutates task state directly.
 */

import type { Logger } from '@invoker/contracts';
import type {
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildFixWithAgentMutationArgs,
  listOpenFixIntentsForTask,
} from './auto-fix-intents.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import type { RecoveryWorkerWakeupHint, WorkflowLifecycleEvent } from './lifecycle-events.js';

/** Why a given tick is running. */
export type WorkerTickReason = 'startup' | 'poll' | 'wake' | 'manual';

/** Stable identity for a worker runtime instance. */
export interface WorkerIdentity {
  /** Worker family, e.g. `'recovery'`. Shared across instances. */
  readonly kind: string;
  /** Unique id for this runtime instance within the process. */
  readonly instanceId: string;
}

/** Context handed to every tick. */
export interface WorkerTickContext {
  readonly identity: WorkerIdentity;
  /** What triggered this tick. */
  readonly reason: WorkerTickReason;
  /** 1-based count of ticks that have started for this runtime. */
  readonly tickNumber: number;
}

/** The unit of work a worker performs on each tick. */
export type WorkerTick = (ctx: WorkerTickContext) => void | Promise<void>;

export interface WorkerRuntimeOptions {
  /** Worker family. Combined with `instanceId` to form the identity. */
  kind: string;
  /** Explicit instance id. Generated deterministically per process when omitted. */
  instanceId?: string;
  logger: Logger;
  /** Work performed on every tick. */
  onTick: WorkerTick;
  /** Periodic poll interval in ms. `<= 0` disables polling (wakeup-only). */
  intervalMs?: number;
  /** Run a tick immediately when `start()` is called. Default `true`. */
  tickOnStart?: boolean;
  /** OS signals that trigger deterministic shutdown. Default `SIGINT`/`SIGTERM`. */
  shutdownSignals?: NodeJS.Signals[];
  /** Install process signal handlers on `start()`. Default `true`. */
  installSignalHandlers?: boolean;
}

export interface WorkerRuntime {
  /** Stable identity for this runtime. */
  readonly identity: WorkerIdentity;
  /** Begin polling and (optionally) install signal handlers. Idempotent. */
  start(): void;
  /** Request a coalesced tick outside the poll cadence. */
  wake(reason?: WorkerTickReason): void;
  /** Run a single tick now and await it (manual/test hook). */
  tick(reason?: WorkerTickReason): Promise<void>;
  /**
   * Deterministically stop: clear the timer, drop signal handlers, and await
   * any in-flight tick before resolving. Idempotent.
   */
  stop(): Promise<void>;
  /** True between `start()` and `stop()`. */
  isRunning(): boolean;
  /** Read-only operational snapshot for operator status surfaces. */
  getStatus(): WorkerRuntimeStatus;
}

export interface WorkerRuntimeStatus {
  readonly identity: WorkerIdentity;
  readonly running: boolean;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly tickCount: number;
  readonly inFlight: boolean;
  readonly pendingReason: WorkerTickReason | null;
  readonly lastTickAt: string | null;
  readonly lastTickReason: WorkerTickReason | null;
  readonly lastWakeupAt: string | null;
  readonly lastWakeupReason: WorkerTickReason | null;
}

const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

let instanceCounter = 0;

/** Deterministic, collision-free instance id within a single process. */
function nextInstanceId(kind: string): string {
  instanceCounter += 1;
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  return `${kind}-${pid}-${instanceCounter}`;
}

/**
 * Create a worker runtime around `onTick`. The runtime does not start until
 * `start()` is called.
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const identity: WorkerIdentity = {
    kind: options.kind,
    instanceId: options.instanceId ?? nextInstanceId(options.kind),
  };
  const intervalMs = options.intervalMs ?? 0;
  const tickOnStart = options.tickOnStart ?? true;
  const shutdownSignals = options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const logFields = { module: 'worker-runtime', kind: identity.kind, instanceId: identity.instanceId };

  let started = false;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let pendingReason: WorkerTickReason | null = null;
  let tickNumber = 0;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let lastTickAt: string | null = null;
  let lastTickReason: WorkerTickReason | null = null;
  let lastWakeupAt: string | null = null;
  let lastWakeupReason: WorkerTickReason | null = null;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  const runOnce = async (reason: WorkerTickReason): Promise<void> => {
    tickNumber += 1;
    lastTickAt = new Date().toISOString();
    lastTickReason = reason;
    const ctx: WorkerTickContext = { identity, reason, tickNumber };
    try {
      await options.onTick(ctx);
    } catch (err) {
      options.logger.error(`[worker:${identity.kind}] tick failed`, { ...logFields, reason, err });
    }
  };

  // Coalescing scheduler: at most one tick runs at a time. Requests that arrive
  // while a tick is in flight collapse into a single follow-up (keeping the most
  // recent reason), so a burst of wakeups never queues a backlog of ticks.
  const schedule = (reason: WorkerTickReason): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      pendingReason = reason;
      return inFlight;
    }
    const drain = async (firstReason: WorkerTickReason): Promise<void> => {
      let nextReason: WorkerTickReason | null = firstReason;
      while (nextReason !== null && !stopped) {
        const current = nextReason;
        pendingReason = null;
        await runOnce(current);
        nextReason = pendingReason;
      }
    };
    inFlight = drain(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const wake = (reason: WorkerTickReason = 'wake'): void => {
    if (stopped) return;
    lastWakeupAt = new Date().toISOString();
    lastWakeupReason = reason;
    void schedule(reason);
  };

  const tick = (reason: WorkerTickReason = 'manual'): Promise<void> => schedule(reason);

  const start = (): void => {
    if (stopped) {
      throw new Error(`worker runtime ${identity.kind}/${identity.instanceId} cannot start after stop`);
    }
    if (started) return;
    started = true;
    startedAt = new Date().toISOString();
    stoppedAt = null;
    options.logger.info(
      `[worker:${identity.kind}] started intervalMs=${intervalMs} signals=${installSignalHandlers ? shutdownSignals.join(',') : 'none'}`,
      logFields,
    );

    if (installSignalHandlers) {
      for (const signal of shutdownSignals) {
        const handler = (): void => {
          options.logger.info(`[worker:${identity.kind}] received ${signal}; shutting down`, logFields);
          void stop();
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    if (intervalMs > 0) {
      interval = setInterval(() => wake('poll'), intervalMs);
      interval.unref?.();
    }

    if (tickOnStart) wake('startup');
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      // Idempotent: a second stop still waits for any in-flight tick to settle.
      if (inFlight) await inFlight.catch(() => undefined);
      return;
    }
    stopped = true;
    stoppedAt = new Date().toISOString();
    pendingReason = null;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
    // Deterministic shutdown: never resolve while a tick is still running.
    if (inFlight) await inFlight.catch(() => undefined);
    options.logger.info(`[worker:${identity.kind}] stopped`, logFields);
  };

  const isRunning = (): boolean => started && !stopped;

  const getStatus = (): WorkerRuntimeStatus => ({
    identity,
    running: isRunning(),
    startedAt,
    stoppedAt,
    tickCount: tickNumber,
    inFlight: Boolean(inFlight),
    pendingReason,
    lastTickAt,
    lastTickReason,
    lastWakeupAt,
    lastWakeupReason,
  });

  return { identity, start, wake, tick, stop, isRunning, getStatus };
}

// ── Recovery worker ──────────────────────────────────────────

/** Public worker kind for the auto-fix recovery worker. */
export const RECOVERY_WORKER_KIND = 'recovery';

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;
const AUTO_FIX_COMMAND_CHANNEL = 'invoker:fix-with-agent';

export interface AutoFixRecoveryPersistence {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface AutoFixRecoverySubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface AutoFixRecoveryPolicyOptions {
  persistence: AutoFixRecoveryPersistence;
  submitter: AutoFixRecoverySubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getRetryBudget?: (task: TaskState) => number;
  consumeWakeups?: () => RecoveryWorkerWakeupHint[];
  onActivity?: (activity: AutoFixRecoveryActivity) => void;
}

export type AutoFixRecoveryActivity =
  | {
      type: 'scan';
      at: string;
      reason: WorkerTickReason;
      candidateCount: number;
      wakeupCount: number;
      source: 'scan' | 'wakeup';
    }
  | {
      type: 'skip';
      at: string;
      taskId: string;
      workflowId: string;
      reason: string;
      source: 'scan' | 'wakeup';
    }
  | {
      type: 'submit';
      at: string;
      taskId: string;
      workflowId: string;
      intentId: number;
      channel: string;
    };

type AutoFixRecoveryCandidate = {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  source: 'scan' | 'wakeup';
};

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function retryBudgetForTask(task: TaskState, options: AutoFixRecoveryPolicyOptions): number {
  const raw = options.getRetryBudget?.(task) ?? options.defaultAutoFixRetries ?? 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.floor(raw)), 10);
}

function isRuntimeAutoFixEligibleTask(task: TaskState, options: AutoFixRecoveryPolicyOptions): boolean {
  if (task.status !== 'failed') return false;
  if (task.config.isReconciliation) return false;
  if (task.config.parentTask) return false;
  if (shouldSkipAutoFixForError(task.execution.error)) return false;
  const max = retryBudgetForTask(task, options);
  if (max <= 0) return false;
  return (task.execution.autoFixAttempts ?? 0) < max;
}

function candidateFromTask(task: TaskState): AutoFixRecoveryCandidate | undefined {
  const workflowId = workflowIdForTask(task);
  if (!workflowId) return undefined;
  return {
    taskId: task.id,
    workflowId,
    generation: task.execution.generation ?? 0,
    taskStateVersion: task.taskStateVersion,
    attemptId: task.execution.selectedAttemptId,
    source: 'scan',
  };
}

function candidateFromWakeup(wakeup: RecoveryWorkerWakeupHint): AutoFixRecoveryCandidate | undefined {
  if (!wakeup.taskId || wakeup.taskStateVersion == null) return undefined;
  return {
    taskId: wakeup.taskId,
    workflowId: wakeup.workflowId,
    generation: wakeup.generation,
    taskStateVersion: wakeup.taskStateVersion,
    attemptId: wakeup.attemptId,
    source: 'wakeup',
  };
}

function dedupeCandidates(candidates: AutoFixRecoveryCandidate[]): AutoFixRecoveryCandidate[] {
  const seen = new Set<string>();
  const deduped: AutoFixRecoveryCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.taskId}:${candidate.generation}:${candidate.taskStateVersion}:${candidate.attemptId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function listScanCandidates(options: AutoFixRecoveryPolicyOptions): AutoFixRecoveryCandidate[] {
  const candidates: AutoFixRecoveryCandidate[] = [];
  for (const workflow of options.persistence.listWorkflows()) {
    for (const task of options.persistence.loadTasks(workflow.id)) {
      if (task.status !== 'failed') continue;
      const candidate = candidateFromTask(task);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function loadLatestTask(
  candidate: AutoFixRecoveryCandidate,
  options: AutoFixRecoveryPolicyOptions,
): TaskState | undefined {
  const direct = options.persistence.loadTask?.(candidate.taskId);
  if (direct) return direct;
  return options.persistence.loadTasks(candidate.workflowId).find((task) => task.id === candidate.taskId);
}

function logAutoFixWorkerEvent(
  options: AutoFixRecoveryPolicyOptions,
  taskId: string,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = { phase, worker: RECOVERY_WORKER_KIND, ...details };
  options.persistence.logEvent?.(taskId, 'debug.auto-fix', payload);
  options.logger.debug?.(`[worker:${RECOVERY_WORKER_KIND}] ${phase}`, {
    module: 'worker-runtime',
    taskId,
    ...details,
  });
}

function skipAutoFixCandidate(
  options: AutoFixRecoveryPolicyOptions,
  candidate: AutoFixRecoveryCandidate,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  options.onActivity?.({
    type: 'skip',
    at: new Date().toISOString(),
    taskId: candidate.taskId,
    workflowId: candidate.workflowId,
    reason,
    source: candidate.source,
  });
  logAutoFixWorkerEvent(options, candidate.taskId, 'worker-autofix-skip', {
    reason,
    source: candidate.source,
    workflowId: candidate.workflowId,
    generation: candidate.generation,
    taskStateVersion: candidate.taskStateVersion,
    attemptId: candidate.attemptId ?? null,
    ...details,
  });
}

function validateAutoFixCandidate(
  candidate: AutoFixRecoveryCandidate,
  options: AutoFixRecoveryPolicyOptions,
): TaskState | undefined {
  const latest = loadLatestTask(candidate, options);
  if (!latest) {
    skipAutoFixCandidate(options, candidate, 'task-not-found');
    return undefined;
  }

  const latestWorkflowId = workflowIdForTask(latest);
  if (latestWorkflowId !== candidate.workflowId) {
    skipAutoFixCandidate(options, candidate, 'stale-workflow', { latestWorkflowId: latestWorkflowId ?? null });
    return undefined;
  }
  if ((latest.execution.generation ?? 0) !== candidate.generation) {
    skipAutoFixCandidate(options, candidate, 'stale-generation', {
      latestGeneration: latest.execution.generation ?? 0,
    });
    return undefined;
  }
  if (latest.taskStateVersion !== candidate.taskStateVersion) {
    skipAutoFixCandidate(options, candidate, 'stale-task-state-version', {
      latestTaskStateVersion: latest.taskStateVersion,
    });
    return undefined;
  }
  if ((latest.execution.selectedAttemptId ?? null) !== (candidate.attemptId ?? null)) {
    skipAutoFixCandidate(options, candidate, 'stale-attempt', {
      latestAttemptId: latest.execution.selectedAttemptId ?? null,
    });
    return undefined;
  }
  if (!isRuntimeAutoFixEligibleTask(latest, options)) {
    skipAutoFixCandidate(options, candidate, 'not-eligible', {
      status: latest.status,
      autoFixAttempts: latest.execution.autoFixAttempts ?? 0,
      maxRetries: retryBudgetForTask(latest, options),
      isReconciliation: Boolean(latest.config.isReconciliation),
      hasParentTask: Boolean(latest.config.parentTask),
      skippedForError: shouldSkipAutoFixForError(latest.execution.error),
    });
    return undefined;
  }

  const openIntents = options.persistence.listWorkflowMutationIntents(candidate.workflowId, ['queued', 'running']);
  const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, candidate.taskId);
  if (openTaskFixIntents.length > 0) {
    skipAutoFixCandidate(options, candidate, 'already-queued-intent', {
      existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
    });
    return undefined;
  }

  return latest;
}

export function createAutoFixRecoveryTick(options: AutoFixRecoveryPolicyOptions): WorkerTick {
  return async (ctx) => {
    const wakeups = options.consumeWakeups?.() ?? [];
    const wakeupCandidates = wakeups.map(candidateFromWakeup).filter((c): c is AutoFixRecoveryCandidate => Boolean(c));
    const source = wakeupCandidates.length > 0 && ctx.reason === 'wake' ? 'wakeup' : 'scan';
    const candidates = dedupeCandidates(
      source === 'wakeup'
        ? wakeupCandidates
        : listScanCandidates(options),
    );
    options.onActivity?.({
      type: 'scan',
      at: new Date().toISOString(),
      reason: ctx.reason,
      candidateCount: candidates.length,
      wakeupCount: wakeups.length,
      source,
    });
    const submittedThisTick = new Set<string>();

    for (const candidate of candidates) {
      if (submittedThisTick.has(candidate.taskId)) {
        skipAutoFixCandidate(options, candidate, 'duplicate-candidate');
        continue;
      }
      const latest = validateAutoFixCandidate(candidate, options);
      if (!latest) continue;

      const configuredAgent = options.getAutoFixAgent?.()?.trim();
      const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
      const args = buildFixWithAgentMutationArgs(latest.id, selectedAgent, { autoFix: true });
      const intentId = options.submitter.submit(candidate.workflowId, 'normal', AUTO_FIX_COMMAND_CHANNEL, args);
      submittedThisTick.add(candidate.taskId);
      options.onActivity?.({
        type: 'submit',
        at: new Date().toISOString(),
        taskId: candidate.taskId,
        workflowId: candidate.workflowId,
        intentId,
        channel: AUTO_FIX_COMMAND_CHANNEL,
      });
      logAutoFixWorkerEvent(options, candidate.taskId, 'worker-autofix-submitted', {
        workflowId: candidate.workflowId,
        intentId,
        channel: AUTO_FIX_COMMAND_CHANNEL,
        generation: candidate.generation,
        taskStateVersion: candidate.taskStateVersion,
        attemptId: candidate.attemptId ?? null,
        agent: selectedAgent ?? null,
        autoFixAttempts: latest.execution.autoFixAttempts ?? 0,
        maxRetries: retryBudgetForTask(latest, options),
      });
    }
  };
}

export interface RecoveryWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  autoFix?: Omit<AutoFixRecoveryPolicyOptions, 'logger' | 'consumeWakeups'>;
  onTick?: WorkerTick;
}

export interface RecoveryWorkerStatus {
  runtime: WorkerRuntimeStatus;
  recovery: {
    kind: 'autofix';
    wakeupCount: number;
    scanCount: number;
    submittedCount: number;
    skippedCount: number;
    lastScanAt: string | null;
    lastScanReason: WorkerTickReason | null;
    lastScanSource: 'scan' | 'wakeup' | null;
    lastScanCandidateCount: number;
    lastWakeupAt: string | null;
    lastWakeupTaskId: string | null;
    lastSubmittedAt: string | null;
    lastSubmittedTaskId: string | null;
    lastSubmittedIntentId: number | null;
    lastSkipAt: string | null;
    lastSkipTaskId: string | null;
    lastSkipReason: string | null;
    skipReasons: Record<string, number>;
  };
}

export interface RecoveryWorkerRuntime extends WorkerRuntime {
  getRecoveryStatus(): RecoveryWorkerStatus;
}

/**
 * Create the recovery worker runtime. When auto-fix dependencies are supplied,
 * the tick scans persisted task state and submits normal fix command intents.
 */
export function createRecoveryWorker(options: RecoveryWorkerOptions): RecoveryWorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const recoveryStatus: RecoveryWorkerStatus['recovery'] = {
    kind: 'autofix',
    wakeupCount: 0,
    scanCount: 0,
    submittedCount: 0,
    skippedCount: 0,
    lastScanAt: null,
    lastScanReason: null,
    lastScanSource: null,
    lastScanCandidateCount: 0,
    lastWakeupAt: null,
    lastWakeupTaskId: null,
    lastSubmittedAt: null,
    lastSubmittedTaskId: null,
    lastSubmittedIntentId: null,
    lastSkipAt: null,
    lastSkipTaskId: null,
    lastSkipReason: null,
    skipReasons: {},
  };
  const recordActivity = (activity: AutoFixRecoveryActivity): void => {
    if (activity.type === 'scan') {
      recoveryStatus.scanCount += 1;
      recoveryStatus.lastScanAt = activity.at;
      recoveryStatus.lastScanReason = activity.reason;
      recoveryStatus.lastScanSource = activity.source;
      recoveryStatus.lastScanCandidateCount = activity.candidateCount;
      return;
    }
    if (activity.type === 'submit') {
      recoveryStatus.submittedCount += 1;
      recoveryStatus.lastSubmittedAt = activity.at;
      recoveryStatus.lastSubmittedTaskId = activity.taskId;
      recoveryStatus.lastSubmittedIntentId = activity.intentId;
      return;
    }
    recoveryStatus.skippedCount += 1;
    recoveryStatus.lastSkipAt = activity.at;
    recoveryStatus.lastSkipTaskId = activity.taskId;
    recoveryStatus.lastSkipReason = activity.reason;
    recoveryStatus.skipReasons[activity.reason] = (recoveryStatus.skipReasons[activity.reason] ?? 0) + 1;
  };
  const onTick = options.onTick ?? (
    options.autoFix
      ? createAutoFixRecoveryTick({
        ...options.autoFix,
        logger: options.logger,
        consumeWakeups: () => pendingWakeups.splice(0),
        onActivity: recordActivity,
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: RECOVERY_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
  if (!options.messageBus || !options.autoFix || options.onTick) {
    return {
      ...runtime,
      getRecoveryStatus: () => ({ runtime: runtime.getStatus(), recovery: { ...recoveryStatus, skipReasons: { ...recoveryStatus.skipReasons } } }),
    };
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          pendingWakeups.push(event.recoveryWakeup);
          recoveryStatus.wakeupCount += 1;
          recoveryStatus.lastWakeupAt = new Date().toISOString();
          recoveryStatus.lastWakeupTaskId = event.recoveryWakeup.taskId ?? null;
          runtime.wake('wake');
        },
      );
    }
    runtime.start();
  };
  const stop = async (): Promise<void> => {
    lifecycleUnsubscribe?.();
    lifecycleUnsubscribe = undefined;
    await runtime.stop();
  };

  return {
    identity: runtime.identity,
    start,
    wake: runtime.wake,
    tick: runtime.tick,
    stop,
    isRunning: runtime.isRunning,
    getStatus: runtime.getStatus,
    getRecoveryStatus: () => ({ runtime: runtime.getStatus(), recovery: { ...recoveryStatus, skipReasons: { ...recoveryStatus.skipReasons } } }),
  };
}
