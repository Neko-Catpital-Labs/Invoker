import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { PrMaintenanceGitHub } from './pr-maintenance-github.js';
import {
  decideWorkflowRetirement,
  WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS,
} from './idle-task-cleanup-policy.js';

export const IDLE_TASK_CLEANUP_WORKER_KIND = 'idle-task-cleanup';
export const DELETE_IDLE_WORKFLOW_CHANNEL = 'invoker:delete-workflow';

const DEFAULT_IDLE_TASK_CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * Hardcoded, not env-gated: this slice only proves workflow-retirement
 * decisions. There is deliberately no live deletion branch to activate.
 */
const FORCE_DRY_RUN = true;

export interface IdleTaskCleanupWorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly status?: string;
  readonly updatedAt?: string | Date;
}

export interface IdleTaskCleanupWorkerStore {
  listWorkflows(): ReadonlyArray<IdleTaskCleanupWorkflowRow>;
  loadTasks(workflowId: string): TaskState[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface IdleTaskCleanupWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof DELETE_IDLE_WORKFLOW_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export type CleanupAction = {
  readonly kind: 'delete-workflow';
  readonly workflowId: string;
  readonly reason: string;
};

/**
 * Pure workflow-level decision planner. It emits at most one retirement action
 * per workflow and cannot represent task, PR, or branch mutations.
 */
export function planIdleTaskCleanup(
  workflows: ReadonlyArray<IdleTaskCleanupWorkflowRow>,
  loadTasks: (workflowId: string) => TaskState[],
  options: {
    readonly now: number;
    readonly idleThresholdMs?: number;
  },
): CleanupAction[] {
  const actions: CleanupAction[] = [];

  for (const workflow of workflows) {
    const decision = decideWorkflowRetirement(workflow, loadTasks(workflow.id), options);
    if (decision.kind === 'retain') continue;

    actions.push({
      kind: 'delete-workflow',
      workflowId: workflow.id,
      reason: decision.reason === 'completed'
        ? 'workflow completed'
        : 'workflow inactive beyond retirement threshold',
    });
  }

  return actions;
}

export interface IdleTaskCleanupWorkerConfig {
  github: PrMaintenanceGitHub;
  intervalMs?: number;
  idleThresholdMs?: number;
  tickOnStart?: boolean;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface IdleTaskCleanupWorkerOptions extends IdleTaskCleanupWorkerConfig {
  logger: Logger;
  store: IdleTaskCleanupWorkerStore;
  submitter: IdleTaskCleanupWorkerSubmitter;
}

export function createIdleTaskCleanupWorker(options: IdleTaskCleanupWorkerOptions): WorkerRuntime {
  const idleThresholdMs = options.idleThresholdMs ?? WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS;
  const now = options.now ?? (() => Date.now());

  return createWorkerRuntime({
    kind: IDLE_TASK_CLEANUP_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_IDLE_TASK_CLEANUP_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const actions = planIdleTaskCleanup(
        options.store.listWorkflows(),
        (workflowId) => options.store.loadTasks(workflowId),
        { now: now(), idleThresholdMs },
      );

      for (const action of actions) {
        if (ctx.signal?.aborted) return;

        if (!FORCE_DRY_RUN) {
          throw new Error('idle-task-cleanup workflow deletion is hard-disabled');
        }

        options.logger.info(
          `[idle-task-cleanup] (dry-run) would delete workflow ${action.workflowId} (${action.reason})`,
          { module: 'idle-task-cleanup', workflowId: action.workflowId },
        );
      }
    },
  });
}

/** Register the built-in idle-task-cleanup worker (dry-run only in this version). */
export function registerIdleTaskCleanupWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: IDLE_TASK_CLEANUP_WORKER_KIND,
    note: 'Dry-run: reports completed or inactive-over-48-hours workflows with no active tasks.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.idleTaskCleanup;
      if (!config) {
        throw new Error('idle-task-cleanup worker requires deps.idleTaskCleanup to be configured');
      }
      return createIdleTaskCleanupWorker({
        logger: deps.logger,
        store: deps.store,
        submitter: deps.submitter,
        github: config.github,
        intervalMs: config.intervalMs,
        idleThresholdMs: config.idleThresholdMs,
        tickOnStart: config.tickOnStart,
        now: config.now,
      });
    },
  });
  return registry;
}
