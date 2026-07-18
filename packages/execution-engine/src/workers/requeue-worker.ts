import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import type { AutoFixRecoveryStore } from '../auto-fix-recovery.js';
import { isLivenessFailureTask } from '../auto-fix-gating.js';
import type { WorkflowLifecycleEvent, RecoveryWorkerWakeupHint } from '../lifecycle-events.js';
import {
  createRequeueAttemptLedger,
  requeueLedgerKeyFromTask,
  type RequeueAttemptLedger,
} from '../requeue-attempt-ledger.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';

export const REQUEUE_WORKER_KIND = 'requeue';

export const REQUEUE_COMMAND_CHANNEL = 'invoker:requeue';
export const REQUEUE_ESCALATE_CHANNEL = 'invoker:requeue-escalate';

const DEFAULT_REQUEUE_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_STALL_REQUEUE_RETRIES = 3;
export const DEFAULT_STALL_REQUEUE_BACKOFF_MS = 120_000;

export interface RequeueWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof REQUEUE_COMMAND_CHANNEL | typeof REQUEUE_ESCALATE_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface RequeueWorkerConfig {
  stallRequeueRetries?: number;
  stallRequeueBackoffMs?: number;
}

export interface RequeueWorkerPolicyOptions {
  store: AutoFixRecoveryStore;
  submitter: RequeueWorkerSubmitter;
  logger: Logger;
  ledger: RequeueAttemptLedger;
  stallRequeueRetries?: number;
  stallRequeueBackoffMs?: number;
  now?: () => number;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
}

export interface RequeueCandidate {
  readonly taskId: string;
  readonly workflowId: string;
}

export interface RequeueMutationArgs {
  readonly taskId: string;
}

export interface RequeueEscalateMutationArgs {
  readonly taskId: string;
  readonly prompt: string;
}

export function buildRequeueMutationArgs(taskId: string): unknown[] {
  return [{ taskId } satisfies RequeueMutationArgs];
}

export function parseRequeueMutationArgs(args: unknown[]): RequeueMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object' || typeof (raw as { taskId?: unknown }).taskId !== 'string') {
    throw new Error('invoker:requeue mutation requires { taskId: string }');
  }
  return { taskId: (raw as RequeueMutationArgs).taskId };
}

export function buildRequeueEscalateMutationArgs(taskId: string, prompt: string): unknown[] {
  return [{ taskId, prompt } satisfies RequeueEscalateMutationArgs];
}

export function parseRequeueEscalateMutationArgs(args: unknown[]): RequeueEscalateMutationArgs {
  const [raw] = args;
  const taskId = (raw as { taskId?: unknown })?.taskId;
  const prompt = (raw as { prompt?: unknown })?.prompt;
  if (typeof taskId !== 'string' || typeof prompt !== 'string') {
    throw new Error('invoker:requeue-escalate mutation requires { taskId: string, prompt: string }');
  }
  return { taskId, prompt };
}

export function buildStallEscalationPrompt(attempts: number, budget: number): string {
  return (
    `Automatic recovery gave up: this task stalled and was requeued ${attempts} time(s) ` +
    `(budget ${budget}) but kept failing with a liveness timeout, not a code failure. ` +
    `That usually means the machine is overloaded or the step needs longer than the ` +
    `executing-stall window. Reduce load or raise INVOKER_EXECUTING_STALL_TIMEOUT_MS, ` +
    `then resume or retry this task.`
  );
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

export function listRequeueScanCandidates(store: AutoFixRecoveryStore): RequeueCandidate[] {
  const candidates: RequeueCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (task.status !== 'failed' || !isLivenessFailureTask(task)) continue;
      const workflowId = workflowIdForTask(task);
      if (workflowId) candidates.push({ taskId: task.id, workflowId });
    }
  }
  return candidates;
}

function loadLatestTask(
  candidate: RequeueCandidate,
  store: AutoFixRecoveryStore,
): TaskState | undefined {
  return store.loadTask?.(candidate.taskId)
    ?? store.loadTasks(candidate.workflowId).find((task) => task.id === candidate.taskId);
}

export function createRequeueRecoveryTick(options: RequeueWorkerPolicyOptions): WorkerTick {
  const budget = options.stallRequeueRetries ?? DEFAULT_STALL_REQUEUE_RETRIES;
  const backoffMs = options.stallRequeueBackoffMs ?? DEFAULT_STALL_REQUEUE_BACKOFF_MS;

  return async (ctx) => {
    const nowMs = options.now?.() ?? Date.now();
    const wakeups = options.drainWakeupHints?.() ?? [];
    const wakeupCandidates: RequeueCandidate[] = wakeups
      .filter((hint): hint is RecoveryWorkerWakeupHint & { taskId: string } => Boolean(hint?.taskId))
      .map((hint) => ({ taskId: hint.taskId, workflowId: hint.workflowId }));
    const candidates = wakeupCandidates.length > 0 && ctx.reason === 'wake'
      ? wakeupCandidates
      : listRequeueScanCandidates(options.store);

    const handled = new Set<string>();
    for (const candidate of candidates) {
      if (handled.has(candidate.taskId)) continue;
      const latest = loadLatestTask(candidate, options.store);
      // Re-check authoritative state: only a task still parked as a liveness
      // stall is actionable (a requeue/escalation already applied would have
      // cleared the class or moved it out of `failed`).
      if (!latest || latest.status !== 'failed' || !isLivenessFailureTask(latest)) continue;
      const workflowId = workflowIdForTask(latest);
      if (!workflowId) continue;
      handled.add(candidate.taskId);

      const key = requeueLedgerKeyFromTask(latest);
      const decision = options.ledger.decide(key, budget, backoffMs, nowMs);

      if (decision.kind === 'backoff') {
        options.logger.debug?.(`[worker:${REQUEUE_WORKER_KIND}] requeue-backoff`, {
          module: 'requeue-worker',
          taskId: latest.id,
          workflowId,
          attempts: decision.attempts,
          budget: decision.budget,
          waitMs: decision.waitMs,
        });
        continue;
      }

      if (decision.kind === 'escalate') {
        if (options.ledger.hasEscalated(key)) continue;
        const prompt = buildStallEscalationPrompt(decision.attempts, decision.budget);
        const intentId = options.submitter.submit(
          workflowId,
          'normal',
          REQUEUE_ESCALATE_CHANNEL,
          buildRequeueEscalateMutationArgs(latest.id, prompt),
        );
        options.ledger.markEscalated(key);
        options.store.logEvent?.(latest.id, 'recovery.worker.submit', {
          worker: REQUEUE_WORKER_KIND,
          phase: 'requeue-escalate',
          workflowId,
          intentId,
          channel: REQUEUE_ESCALATE_CHANNEL,
          attempts: decision.attempts,
          budget: decision.budget,
        });
        options.logger.info(`[worker:${REQUEUE_WORKER_KIND}] escalated stalled task to needs_input`, {
          module: 'requeue-worker',
          taskId: latest.id,
          workflowId,
          attempts: decision.attempts,
          budget: decision.budget,
        });
        continue;
      }

      const intentId = options.submitter.submit(
        workflowId,
        'normal',
        REQUEUE_COMMAND_CHANNEL,
        buildRequeueMutationArgs(latest.id),
      );
      options.store.logEvent?.(latest.id, 'recovery.worker.submit', {
        worker: REQUEUE_WORKER_KIND,
        phase: 'requeue',
        workflowId,
        intentId,
        channel: REQUEUE_COMMAND_CHANNEL,
        attempt: decision.attemptsAfter,
        budget: decision.budget,
      });
      options.logger.info(`[worker:${REQUEUE_WORKER_KIND}] requeued stalled task`, {
        module: 'requeue-worker',
        taskId: latest.id,
        workflowId,
        attempt: decision.attemptsAfter,
        budget: decision.budget,
      });
    }
  };
}

export interface RequeueWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  requeue?: Omit<RequeueWorkerPolicyOptions, 'logger' | 'drainWakeupHints' | 'ledger'> & {
    readonly ledger?: RequeueAttemptLedger;
  };
  onTick?: WorkerTick;
}

export function createRequeueWorker(options: RequeueWorkerOptions): WorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.requeue
      ? createRequeueRecoveryTick({
        ...options.requeue,
        ledger: options.requeue.ledger ?? createRequeueAttemptLedger(),
        logger: options.logger,
        drainWakeupHints: () => pendingWakeups.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: REQUEUE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_REQUEUE_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
  if (!options.messageBus || !options.requeue || options.onTick) {
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

export function registerRequeueWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: REQUEUE_WORKER_KIND,
    note: 'Re-runs liveness-stalled tasks (requeue) with bounded budget/backoff; escalates to needs_input.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createRequeueWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        requeue: {
          store: deps.store,
          submitter: deps.submitter,
          stallRequeueRetries: deps.requeue?.stallRequeueRetries,
          stallRequeueBackoffMs: deps.requeue?.stallRequeueBackoffMs,
        },
      }),
  });
  return registry;
}
