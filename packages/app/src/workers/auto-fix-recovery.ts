import type { Logger } from '@invoker/contracts';
import type {
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

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
}

export type AutoFixRecoveryCandidate = {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  source: 'scan';
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

export interface RecoveryWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  /**
   * Behavior-neutral override for the tick. Defaults to a no-op for this slice:
   * the recovery worker does not submit recovery commands yet, and existing
   * auto-fix paths continue to run through their current owner.
   */
  onTick?: WorkerTick;
}

/**
 * Create the recovery worker runtime. By default its tick is a no-op so that
 * standing up the worker is behavior-neutral: no recovery commands are
 * submitted and no existing auto-fix path is rerouted in this slice.
 */
export function createRecoveryWorker(options: RecoveryWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: RECOVERY_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (() => {}),
  });
}
