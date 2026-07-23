import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
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
import {
  autoFixAttemptLedgerKeyFromTask,
  createAutoFixAttemptLedger,
  type AutoFixAttemptLedger,
} from './auto-fix-attempt-ledger.js';
import {
  normalizeAutoFixRetryBudget,
  shouldSkipAutoFixForError,
  isLivenessFailureTask,
} from './auto-fix-gating.js';
import {
  checkAutoFixRetryCap,
  recordAutoFixRetryConsumed,
} from './auto-fix-retry-cap.js';
import { recordWorkerDecisionRow, isMeaningfulSkipReason } from './worker-decision-ledger.js';
import type { WorkflowLifecycleEvent, RecoveryWorkerWakeupHint } from './lifecycle-events.js';
import type { WorkerRuntimeDependencies } from './worker-runtime-dependencies.js';
import type { WorkerRegistry } from './worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from './worker-runtime.js';

/** Registry kind for the built-in auto-fix recovery worker. */
export const AUTO_FIX_WORKER_KIND = 'autofix';
/** Public runtime kind for the underlying auto-fix recovery worker. */
export const RECOVERY_WORKER_KIND = 'recovery';

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;
const AUTO_FIX_COMMAND_CHANNEL = 'invoker:fix-with-agent';
const AUTO_FIX_BARE_RETRY_CHANNEL = 'invoker:restart-task';
const AUTO_FIX_ACTION_TYPE = 'auto-fix';
const AUTO_FIX_BARE_RETRY_ACTION_TYPE = 'auto-retry';

const AUTO_FIX_WORKER_AUDIT_EVENTS: Record<string, { eventType: string; action: 'submit' | 'skip' }> = {
  'worker-autofix-submitted': { eventType: 'recovery.worker.submit', action: 'submit' },
  'worker-autofix-bare-retry-submitted': { eventType: 'recovery.worker.submit', action: 'submit' },
  'worker-autofix-skip': { eventType: 'recovery.worker.skip', action: 'skip' },
};

export interface AutoFixRecoveryStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface AutoFixRecoverySubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof AUTO_FIX_COMMAND_CHANNEL | typeof AUTO_FIX_BARE_RETRY_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}
export interface AutoFixWorkerConfig {
  /** Maximum auto-fix attempts per failed task. Positive finite values are caps; zero disables auto-fix. */
  defaultAutoFixRetries?: number;
  /** Runtime-local ledger for consumed auto-fix attempts. */
  attemptLedger?: AutoFixAttemptLedger;
  /** Resolves the agent that performs each auto-fix, when one is configured. */
  getAutoFixAgent?: () => string | undefined;
  /** Resolves the execution model used by worker-submitted auto-fixes. */
  getAutoFixExecutionModel?: () => string | undefined;
}


export interface AutoFixRecoveryPolicyOptions {
  store: AutoFixRecoveryStore;
  submitter: AutoFixRecoverySubmitter;
  logger: Logger;
  attemptLedger: AutoFixAttemptLedger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getRetryBudget?: (task: TaskState) => number;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
}
/** Register the built-in auto-fix worker. */
export function registerAutoFixWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: AUTO_FIX_WORKER_KIND,
    note: 'Auto-fixes failed tasks by submitting fix-with-agent recovery intents.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createRecoveryWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        tickOnStart: true,
        autoFix: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          attemptLedger: deps.autoFix?.attemptLedger,
        },
      }),
  });
  return registry;
}

export type AutoFixRecoveryCandidate = {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  source: 'scan' | 'wakeup';
};

type AutoFixRecoveryTaskRef = Omit<AutoFixRecoveryCandidate, 'source'>;

export type ValidatedAutoFixRecoveryCandidate = AutoFixRecoveryTaskRef & {
  source: AutoFixRecoveryCandidate['source'];
  task: TaskState;
};

type AutoFixCandidateSnapshotMismatchReason =
  | 'stale-workflow'
  | 'stale-generation'
  | 'stale-task-state-version'
  | 'stale-attempt';

type AutoFixCandidateSnapshotComparison =
  | { ok: true; ref: AutoFixRecoveryTaskRef }
  | {
    ok: false;
    reason: AutoFixCandidateSnapshotMismatchReason;
    details: Record<string, unknown>;
  };

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function taskRefFromTask(task: TaskState): AutoFixRecoveryTaskRef | undefined {
  const workflowId = workflowIdForTask(task);
  if (!workflowId) return undefined;
  return {
    taskId: task.id,
    workflowId,
    generation: task.execution.generation ?? 0,
    taskStateVersion: task.taskStateVersion,
    attemptId: task.execution.selectedAttemptId,
  };
}

function candidateFromTask(task: TaskState): AutoFixRecoveryCandidate | undefined {
  const ref = taskRefFromTask(task);
  if (!ref) return undefined;
  return {
    ...ref,
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
  return normalizeAutoFixRetryBudget(options.getRetryBudget?.(task) ?? options.defaultAutoFixRetries ?? 0);
}


function retryBudgetLabel(budget: number): number | 'unlimited' {
  return budget === Number.POSITIVE_INFINITY ? 'unlimited' : budget;
}

function isRuntimeAutoFixEligibleTask(task: TaskState, options: AutoFixRecoveryPolicyOptions): boolean {
  if (task.status !== 'failed') return false;
  if (task.config.isReconciliation) return false;
  if (task.config.parentTask) return false;
  if (shouldSkipAutoFixForError(task.execution.error)) return false;
  // Liveness stalls (executor stopped heartbeating) are re-run by the requeue
  // worker, not "fixed" by the AI — auto-fix would loop on a non-defect.
  if (isLivenessFailureTask(task)) return false;
  const max = retryBudgetForTask(task, options);
  if (max <= 0) return false;
  return true;
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

  const auditEvent = AUTO_FIX_WORKER_AUDIT_EVENTS[phase];
  if (auditEvent) {
    options.store.logEvent?.(taskId, auditEvent.eventType, {
      workerId: 'auto-fix-recovery',
      kind: RECOVERY_WORKER_KIND,
      owner: 'auto-fix',
      action: auditEvent.action,
      phase,
      ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
      ...(typeof details.status === 'string' ? { status: details.status } : {}),
      ...(typeof details.workflowId === 'string' || details.workflowId === null ? { workflowId: details.workflowId } : {}),
      details: { worker: RECOVERY_WORKER_KIND, ...details },
    });
  }

  options.logger.debug?.(`[worker:${RECOVERY_WORKER_KIND}] ${phase}`, {
    module: 'auto-fix-recovery',
    taskId,
    ...details,
  });
}

function autoFixDecisionExternalKey(candidate: AutoFixRecoveryCandidate): string {
  return `${AUTO_FIX_WORKER_KIND}:${candidate.taskId}:${candidate.generation}:${candidate.attemptId ?? ''}`;
}

function autoFixBareRetryExternalKey(candidate: AutoFixRecoveryCandidate): string {
  // Bare retry is once-per-task: after restart-task bumps generation, the next
  // failure must escalate to fix-with-agent instead of another bare retry.
  return `${AUTO_FIX_WORKER_KIND}:retry:${candidate.taskId}`;
}

function recordAutoFixDecisionRow(
  options: AutoFixRecoveryPolicyOptions,
  candidate: AutoFixRecoveryCandidate,
  fields: {
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    intentId?: number;
    agentName?: string;
    incrementAttempt?: boolean;
    extraPayload?: Record<string, unknown>;
  },
): void {
  recordWorkerDecisionRow(options.store, {
    workerKind: AUTO_FIX_WORKER_KIND,
    actionType: AUTO_FIX_ACTION_TYPE,
    externalKey: autoFixDecisionExternalKey(candidate),
    subjectType: 'task',
    subjectId: candidate.taskId,
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    status: fields.status,
    summary: fields.summary,
    reason: fields.reason,
    intentId: fields.intentId,
    agentName: fields.agentName,
    incrementAttempt: fields.incrementAttempt,
    payload: {
      source: candidate.source,
      generation: candidate.generation,
      attemptId: candidate.attemptId ?? null,
      taskStateVersion: candidate.taskStateVersion,
      ...fields.extraPayload,
    },
  });
}

function recordAutoFixBareRetryRow(
  options: AutoFixRecoveryPolicyOptions,
  candidate: AutoFixRecoveryCandidate,
  fields: {
    status: WorkerActionStatus;
    summary: string;
    intentId?: number;
    extraPayload?: Record<string, unknown>;
  },
): void {
  recordWorkerDecisionRow(options.store, {
    workerKind: AUTO_FIX_WORKER_KIND,
    actionType: AUTO_FIX_BARE_RETRY_ACTION_TYPE,
    externalKey: autoFixBareRetryExternalKey(candidate),
    subjectType: 'task',
    subjectId: candidate.taskId,
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    status: fields.status,
    summary: fields.summary,
    intentId: fields.intentId,
    incrementAttempt: true,
    payload: {
      source: candidate.source,
      generation: candidate.generation,
      attemptId: candidate.attemptId ?? null,
      taskStateVersion: candidate.taskStateVersion,
      ...fields.extraPayload,
    },
  });
}

function hasBareRetryAlreadySubmitted(
  options: AutoFixRecoveryPolicyOptions,
  candidate: AutoFixRecoveryCandidate,
): boolean {
  const existing = options.store.getWorkerAction?.(
    AUTO_FIX_WORKER_KIND,
    autoFixBareRetryExternalKey(candidate),
  );
  if (!existing) return false;
  return existing.attemptCount > 0;
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
  if (isMeaningfulSkipReason(reason)) {
    recordAutoFixDecisionRow(options, candidate, {
      status: 'skipped',
      summary: `Skipped auto-fix: ${reason}`,
      reason,
      extraPayload: details,
    });
  }
}

function compareAutoFixCandidateSnapshot(
  candidate: AutoFixRecoveryCandidate,
  latest: TaskState,
): AutoFixCandidateSnapshotComparison {
  const latestRef = taskRefFromTask(latest);
  if (!latestRef || latestRef.workflowId !== candidate.workflowId) {
    return {
      ok: false,
      reason: 'stale-workflow',
      details: { latestWorkflowId: latestRef?.workflowId ?? null },
    };
  }

  if (latestRef.generation !== candidate.generation) {
    return {
      ok: false,
      reason: 'stale-generation',
      details: { latestGeneration: latestRef.generation },
    };
  }

  if (latestRef.taskStateVersion !== candidate.taskStateVersion) {
    return {
      ok: false,
      reason: 'stale-task-state-version',
      details: { latestTaskStateVersion: latestRef.taskStateVersion },
    };
  }

  const latestAttemptId = latestRef.attemptId ?? null;
  if (latestAttemptId !== (candidate.attemptId ?? null)) {
    return {
      ok: false,
      reason: 'stale-attempt',
      details: { latestAttemptId },
    };
  }

  return { ok: true, ref: latestRef };
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
  const latestRef = snapshotComparison.ref;

  const latestRetryBudget = retryBudgetForTask(latest, options);
  if (!isRuntimeAutoFixEligibleTask(latest, options)) {
    const reason = latestRetryBudget <= 0
      ? 'retry-budget-disabled'
      : 'not-eligible';
    skipAutoFixCandidate(options, candidate, reason, {
      status: latest.status,
      workerRetryBudget: retryBudgetLabel(latestRetryBudget),
      isReconciliation: Boolean(latest.config.isReconciliation),
      hasParentTask: Boolean(latest.config.parentTask),
      skippedForError: shouldSkipAutoFixForError(latest.execution.error),
    });
    return undefined;
  }

  const openIntents = options.store.listWorkflowMutationIntents(latestRef.workflowId, ['queued', 'running']);
  const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, candidate.taskId);
  if (openTaskFixIntents.length > 0) {
    skipAutoFixCandidate(options, candidate, 'already-queued-intent', {
      existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
    });
    return undefined;
  }

  return { ...latestRef, source: candidate.source, task: latest };
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
    ctx.signal?.throwIfAborted();
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

      const retryCap = checkAutoFixRetryCap(
        options.store,
        candidate.taskId,
        retryBudgetForTask(candidate.task, options),
      );
      if (!retryCap.allowed) {
        skipAutoFixCandidate(options, candidate, 'worker-retry-budget-exhausted', {
          status: candidate.task.status,
          consumedRetries: retryCap.consumed,
          workerRetryBudget: retryBudgetLabel(retryCap.budget),
        });
        continue;
      }

      if (!hasBareRetryAlreadySubmitted(options, candidate)) {
        const intentId = options.submitter.submit(
          candidate.workflowId,
          'normal',
          AUTO_FIX_BARE_RETRY_CHANNEL,
          [candidate.taskId],
        );
        submittedThisTick.add(candidate.taskId);
        logAutoFixWorkerEvent(options, candidate.taskId, 'worker-autofix-bare-retry-submitted', {
          workflowId: candidate.workflowId,
          intentId,
          channel: AUTO_FIX_BARE_RETRY_CHANNEL,
          generation: candidate.generation,
          taskStateVersion: candidate.taskStateVersion,
          attemptId: candidate.attemptId ?? null,
        });
        recordAutoFixBareRetryRow(options, candidate, {
          status: 'queued',
          summary: 'Queued bare retry-task before consuming auto-fix attempts',
          intentId,
          extraPayload: {
            channel: AUTO_FIX_BARE_RETRY_CHANNEL,
          },
        });
        recordAutoFixRetryConsumed(options.store, candidate.taskId, {
          workflowId: candidate.workflowId,
        });
        continue;
      }

      const retryBudget = retryBudgetForTask(candidate.task, options);
      const attemptDecision = options.attemptLedger.consume(
        autoFixAttemptLedgerKeyFromTask(candidate.task),
        retryBudget,
      );
      if (!attemptDecision.allowed) {
        skipAutoFixCandidate(options, candidate, attemptDecision.reason, {
          status: candidate.task.status,
          workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
        });
        continue;
      }
      const configuredAgent = options.getAutoFixAgent?.()?.trim();
      const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
      options.logger.debug?.(`[worker:${RECOVERY_WORKER_KIND}] worker-autofix-attempt-consumed`, {
        module: 'auto-fix-recovery',
        taskId: candidate.taskId,
        workflowId: candidate.workflowId,
        generation: candidate.generation,
        attemptId: candidate.attemptId ?? null,
        attemptsBefore: attemptDecision.attemptsBefore,
        attemptsAfter: attemptDecision.attemptsAfter,
        workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
      });
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
        workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
      });
      recordAutoFixDecisionRow(options, candidate, {
        status: 'queued',
        summary: 'Queued auto-fix with agent',
        intentId,
        agentName: selectedAgent,
        incrementAttempt: true,
        extraPayload: {
          channel: AUTO_FIX_COMMAND_CHANNEL,
          workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
        },
      });
      recordAutoFixRetryConsumed(options.store, candidate.taskId, {
        workflowId: candidate.workflowId,
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
  autoFix?: Omit<AutoFixRecoveryPolicyOptions, 'logger' | 'drainWakeupHints' | 'attemptLedger'> & { readonly attemptLedger?: AutoFixAttemptLedger };
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
  const fallbackAttemptLedger = options.autoFix && !options.autoFix.attemptLedger
    ? createAutoFixAttemptLedger()
    : undefined;
  const onTick = options.onTick ?? (
    options.autoFix
      ? createAutoFixRecoveryTick({
        ...options.autoFix,
        attemptLedger: options.autoFix.attemptLedger ?? fallbackAttemptLedger!,
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
