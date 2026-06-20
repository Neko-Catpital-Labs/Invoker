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
} from '../auto-fix-intents.js';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import type { RecoveryWorkerWakeupHint, WorkflowLifecycleEvent } from '../lifecycle-events.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

/** Public worker kind for the auto-fix recovery worker. */
export const RECOVERY_WORKER_KIND = 'recovery';

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;
const AUTO_FIX_COMMAND_CHANNEL = 'invoker:fix-with-agent';

export interface AutoFixRecoveryStore {
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
    channel: typeof AUTO_FIX_COMMAND_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface AutoFixRecoveryPolicyOptions {
  store: AutoFixRecoveryStore;
  submitter: AutoFixRecoverySubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getRetryBudget?: (task: TaskState) => number;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
}

export type AutoFixRecoveryCandidate = {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  source: 'scan' | 'wakeup';
};

export type ValidatedAutoFixRecoveryCandidate = AutoFixRecoveryCandidate & {
  task: TaskState;
};

type AutoFixCandidateSnapshotMismatchReason =
  | 'stale-workflow'
  | 'stale-generation'
  | 'stale-task-state-version'
  | 'stale-attempt';

type AutoFixCandidateSnapshotComparison =
  | { ok: true }
  | {
    ok: false;
    reason: AutoFixCandidateSnapshotMismatchReason;
    details: Record<string, unknown>;
  };

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
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

export function listAutoFixRecoveryScanCandidates(
  options: Pick<AutoFixRecoveryPolicyOptions, 'store'>,
): AutoFixRecoveryCandidate[] {
  const candidates: AutoFixRecoveryCandidate[] = [];
  for (const workflow of options.store.listWorkflows()) {
    for (const task of options.store.loadTasks(workflow.id)) {
      if (task.status !== 'failed') continue;
      const candidate = candidateFromTask(task);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
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

function loadLatestTask(
  candidate: AutoFixRecoveryCandidate,
  options: AutoFixRecoveryPolicyOptions,
): TaskState | undefined {
  const direct = options.store.loadTask?.(candidate.taskId);
  if (direct) return direct;
  return options.store.loadTasks(candidate.workflowId).find((task) => task.id === candidate.taskId);
}

function logAutoFixWorkerEvent(
  options: AutoFixRecoveryPolicyOptions,
  taskId: string,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = { phase, worker: RECOVERY_WORKER_KIND, ...details };
  options.store.logEvent?.(taskId, 'debug.auto-fix', payload);
  options.logger.debug?.(`[worker:${RECOVERY_WORKER_KIND}] ${phase}`, {
    module: 'auto-fix-recovery',
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

function compareAutoFixCandidateSnapshot(
  candidate: AutoFixRecoveryCandidate,
  latest: TaskState,
): AutoFixCandidateSnapshotComparison {
  const latestWorkflowId = workflowIdForTask(latest);
  if (latestWorkflowId !== candidate.workflowId) {
    return {
      ok: false,
      reason: 'stale-workflow',
      details: { latestWorkflowId: latestWorkflowId ?? null },
    };
  }

  const latestGeneration = latest.execution.generation ?? 0;
  if (latestGeneration !== candidate.generation) {
    return {
      ok: false,
      reason: 'stale-generation',
      details: { latestGeneration },
    };
  }

  if (latest.taskStateVersion !== candidate.taskStateVersion) {
    return {
      ok: false,
      reason: 'stale-task-state-version',
      details: { latestTaskStateVersion: latest.taskStateVersion },
    };
  }

  const latestAttemptId = latest.execution.selectedAttemptId ?? null;
  if (latestAttemptId !== (candidate.attemptId ?? null)) {
    return {
      ok: false,
      reason: 'stale-attempt',
      details: { latestAttemptId },
    };
  }

  return { ok: true };
}

function validateAutoFixCandidate(
  candidate: AutoFixRecoveryCandidate,
  options: AutoFixRecoveryPolicyOptions,
): ValidatedAutoFixRecoveryCandidate | undefined {
  const latest = loadLatestTask(candidate, options);
  if (!latest) {
    skipAutoFixCandidate(options, candidate, 'task-not-found');
    return undefined;
  }

  const snapshotComparison = compareAutoFixCandidateSnapshot(candidate, latest);
  if (!snapshotComparison.ok) {
    skipAutoFixCandidate(options, candidate, snapshotComparison.reason, snapshotComparison.details);
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

  const openIntents = options.store.listWorkflowMutationIntents(candidate.workflowId, ['queued', 'running']);
  const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, candidate.taskId);
  if (openTaskFixIntents.length > 0) {
    skipAutoFixCandidate(options, candidate, 'already-queued-intent', {
      existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
    });
    return undefined;
  }

  return { ...candidate, task: latest };
}

export function collectValidatedAutoFixRecoveryCandidates(
  options: AutoFixRecoveryPolicyOptions,
  candidates: AutoFixRecoveryCandidate[] = listAutoFixRecoveryScanCandidates(options),
): ValidatedAutoFixRecoveryCandidate[] {
  return candidates
    .map((candidate) => validateAutoFixCandidate(candidate, options))
    .filter((candidate): candidate is ValidatedAutoFixRecoveryCandidate => Boolean(candidate));
}

export function createAutoFixRecoveryTick(options: AutoFixRecoveryPolicyOptions): WorkerTick {
  return async (ctx) => {
    const wakeups = options.drainWakeupHints?.() ?? [];
    const wakeupCandidates = wakeups.map(candidateFromWakeup).filter((c): c is AutoFixRecoveryCandidate => Boolean(c));
    const candidates = dedupeCandidates(
      wakeupCandidates.length > 0 && ctx.reason === 'wake'
        ? wakeupCandidates
        : listAutoFixRecoveryScanCandidates(options),
    );
    const submittedThisTick = new Set<string>();

    for (const candidate of collectValidatedAutoFixRecoveryCandidates(options, candidates)) {
      if (submittedThisTick.has(candidate.taskId)) {
        skipAutoFixCandidate(options, candidate, 'duplicate-candidate');
        continue;
      }
      const configuredAgent = options.getAutoFixAgent?.()?.trim();
      const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
      const args = buildFixWithAgentMutationArgs(candidate.task.id, selectedAgent, { autoFix: true });
      const intentId = options.submitter.submit(candidate.workflowId, 'normal', AUTO_FIX_COMMAND_CHANNEL, args);
      submittedThisTick.add(candidate.taskId);
      logAutoFixWorkerEvent(options, candidate.taskId, 'worker-autofix-submitted', {
        workflowId: candidate.workflowId,
        intentId,
        channel: AUTO_FIX_COMMAND_CHANNEL,
        generation: candidate.generation,
        taskStateVersion: candidate.taskStateVersion,
        attemptId: candidate.attemptId ?? null,
        agent: selectedAgent ?? null,
        autoFixAttempts: candidate.task.execution.autoFixAttempts ?? 0,
        maxRetries: retryBudgetForTask(candidate.task, options),
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
  autoFix?: Omit<AutoFixRecoveryPolicyOptions, 'logger' | 'drainWakeupHints'>;
  /** Test hook or alternate worker policy. Takes precedence over `autoFix`. */
  onTick?: WorkerTick;
}

/**
 * Create the recovery worker runtime. By default its tick is a no-op; supplying
 * `autoFix` installs the dormant auto-fix scan policy.
 */
export function createRecoveryWorker(options: RecoveryWorkerOptions): WorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.autoFix
      ? createAutoFixRecoveryTick({
        ...options.autoFix,
        logger: options.logger,
        drainWakeupHints: () => pendingWakeups.splice(0),
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
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          pendingWakeups.push(event.recoveryWakeup);
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
  };
}
