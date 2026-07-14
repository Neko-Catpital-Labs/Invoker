import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkflowLifecycleEvent, RecoveryWorkerWakeupHint } from '../lifecycle-events.js';
import {
  createWorkerRuntime,
  type WorkerRuntime,
  type WorkerTick,
} from '../worker-runtime.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';

export const WORKFLOW_RESUME_WORKER_KIND = 'workflow-resume';

export const WORKFLOW_RESUME_COMMAND_CHANNEL = 'invoker:start-ready';

const DEFAULT_WORKFLOW_RESUME_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_WORKFLOW_RESUME_COOLDOWN_MS = 60_000;

export interface WorkflowResumeWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  logEvent?(entityId: string, eventType: string, payload?: unknown): void;
}

export interface WorkflowResumeWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof WORKFLOW_RESUME_COMMAND_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface WorkflowResumeWorkerConfig {
  cooldownMs?: number;
  pollIntervalMs?: number;
  enabled?: boolean;
}

export interface WorkflowResumeCooldownLedger {
  shouldSubmit(workflowId: string, nowMs: number): boolean;
  markSubmitted(workflowId: string, nowMs: number): void;
}

export interface WorkflowResumeWorkerPolicyOptions {
  store: WorkflowResumeWorkerStore;
  submitter: WorkflowResumeWorkerSubmitter;
  logger: Logger;
  ledger: WorkflowResumeCooldownLedger;
  cooldownMs?: number;
  now?: () => number;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
}

export function createWorkflowResumeCooldownLedger(): WorkflowResumeCooldownLedger {
  const nextEligibleAtMs = new Map<string, number>();
  return {
    shouldSubmit(workflowId, nowMs) {
      const eligibleAt = nextEligibleAtMs.get(workflowId);
      return eligibleAt === undefined ? true : nowMs >= eligibleAt;
    },
    markSubmitted(workflowId, eligibleAtMs) {
      nextEligibleAtMs.set(workflowId, eligibleAtMs);
    },
  };
}

function hasLocallyReadyPendingTask(store: WorkflowResumeWorkerStore, workflowId: string): boolean {
  const tasks = store.loadTasks(workflowId);
  if (tasks.length === 0) return false;
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const dependencies = task.dependencies ?? [];
    const localDependenciesSatisfied = dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      return dependency === undefined || dependency.status === 'completed';
    });
    if (localDependenciesSatisfied) return true;
  }
  return false;
}

function collectWakeupWorkflowIds(hints: RecoveryWorkerWakeupHint[]): string[] {
  const seen = new Set<string>();
  for (const hint of hints) {
    const workflowId = hint?.workflowId?.trim();
    if (workflowId) seen.add(workflowId);
  }
  return Array.from(seen);
}

function listAllWorkflowsWithReadyPendingTasks(store: WorkflowResumeWorkerStore): string[] {
  const targets: string[] = [];
  for (const workflow of store.listWorkflows()) {
    if (hasLocallyReadyPendingTask(store, workflow.id)) {
      targets.push(workflow.id);
    }
  }
  return targets;
}

export function createWorkflowResumeTick(options: WorkflowResumeWorkerPolicyOptions): WorkerTick {
  const cooldownMs = options.cooldownMs ?? DEFAULT_WORKFLOW_RESUME_COOLDOWN_MS;

  return async (ctx) => {
    const nowMs = options.now?.() ?? Date.now();
    const wakeups = options.drainWakeupHints?.() ?? [];
    const wakeupWorkflowIds = collectWakeupWorkflowIds(wakeups);

    const candidateIds = wakeupWorkflowIds.length > 0 && ctx.reason === 'wake'
      ? wakeupWorkflowIds.filter((id) => hasLocallyReadyPendingTask(options.store, id))
      : listAllWorkflowsWithReadyPendingTasks(options.store);

    const submitted = new Set<string>();
    for (const workflowId of candidateIds) {
      if (submitted.has(workflowId)) continue;
      if (!options.ledger.shouldSubmit(workflowId, nowMs)) {
        options.logger.debug?.(`[worker:${WORKFLOW_RESUME_WORKER_KIND}] cooldown-skip`, {
          module: 'workflow-resume-worker',
          workflowId,
          cooldownMs,
        });
        continue;
      }
      submitted.add(workflowId);

      const intentId = options.submitter.submit(
        workflowId,
        'normal',
        WORKFLOW_RESUME_COMMAND_CHANNEL,
        [{}],
      );
      options.ledger.markSubmitted(workflowId, nowMs + cooldownMs);
      options.store.logEvent?.(workflowId, 'recovery.worker.submit', {
        worker: WORKFLOW_RESUME_WORKER_KIND,
        phase: 'start-ready',
        workflowId,
        intentId,
        channel: WORKFLOW_RESUME_COMMAND_CHANNEL,
      });
      options.logger.info(`[worker:${WORKFLOW_RESUME_WORKER_KIND}] submitted start-ready for pending work`, {
        module: 'workflow-resume-worker',
        workflowId,
        intentId,
      });
    }
  };
}

export interface WorkflowResumeWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  workflowResume?: Omit<WorkflowResumeWorkerPolicyOptions, 'logger' | 'drainWakeupHints' | 'ledger'> & {
    readonly ledger?: WorkflowResumeCooldownLedger;
  };
  onTick?: WorkerTick;
}

export function createWorkflowResumeWorker(options: WorkflowResumeWorkerOptions): WorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.workflowResume
      ? createWorkflowResumeTick({
        ...options.workflowResume,
        ledger: options.workflowResume.ledger ?? createWorkflowResumeCooldownLedger(),
        logger: options.logger,
        drainWakeupHints: () => pendingWakeups.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: WORKFLOW_RESUME_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_WORKFLOW_RESUME_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
  if (!options.messageBus || !options.workflowResume || options.onTick) {
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

export function registerWorkflowResumeWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: WORKFLOW_RESUME_WORKER_KIND,
    note: 'Submits start-ready intents when workflows have pending work ready to launch.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createWorkflowResumeWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        intervalMs: deps.workflowResume?.pollIntervalMs,
        workflowResume: {
          store: deps.store,
          submitter: deps.submitter,
          cooldownMs: deps.workflowResume?.cooldownMs,
        },
      }),
  });
  return registry;
}
