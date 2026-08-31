import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { PrMaintenanceGitHub } from './pr-maintenance-github.js';
import {
  IDLE_WORKFLOW_RETENTION_MS,
  isInactiveCleanupTaskStatus,
  isKnownCleanupWorkflowStatus,
  isWorkflowPastRetention,
} from './idle-task-cleanup-policy.js';

export const IDLE_TASK_CLEANUP_WORKER_KIND = 'idle-task-cleanup';

const DEFAULT_IDLE_TASK_CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * Hardcoded, not env-gated: this slice can only prepare and log retirement
 * actions. A separately reviewed owner handoff must remove this guard and add
 * the workflow deletion path.
 */
const FORCE_DRY_RUN = true;

export interface IdleTaskCleanupWorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdleTaskCleanupWorkerStore {
  listWorkflows(): ReadonlyArray<IdleTaskCleanupWorkflowRow>;
  loadTasks(workflowId: string): TaskState[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

/** Retained as an injected dependency boundary; this dormant slice never calls it. */
export type IdleTaskCleanupWorkerSubmitter = object;

export interface CleanupAction {
  readonly kind: 'delete-workflow';
  readonly workflowId: string;
  readonly reason: string;
}

/**
 * Prepare at most one workflow-retirement action per workflow. Tasks are only
 * retention evidence: this planner never prepares task, PR, or branch edits.
 */
export async function planIdleTaskCleanup(
  workflows: ReadonlyArray<IdleTaskCleanupWorkflowRow>,
  loadTasks: (workflowId: string) => TaskState[],
  opts: {
    now: number;
    retentionMs?: number;
  },
): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];

  for (const workflow of workflows) {
    if (!isKnownCleanupWorkflowStatus(workflow.status)) continue;

    const tasks = loadTasks(workflow.id);
    if (!tasks.every((task) => isInactiveCleanupTaskStatus(task.status))) continue;

    if (workflow.status === 'completed') {
      actions.push({
        kind: 'delete-workflow',
        workflowId: workflow.id,
        reason: 'completed with no active tasks',
      });
      continue;
    }

    if (isWorkflowPastRetention(workflow.updatedAt, opts.now, opts.retentionMs)) {
      actions.push({
        kind: 'delete-workflow',
        workflowId: workflow.id,
        reason: 'inactive for more than 48 hours',
      });
    }
  }

  return actions;
}

export interface IdleTaskCleanupWorkerConfig {
  /** Compatibility-only until the owner handoff; workflow cleanup performs no GitHub IO. */
  github: PrMaintenanceGitHub;
  intervalMs?: number;
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

      const actions = await planIdleTaskCleanup(
        options.store.listWorkflows(),
        (workflowId) => options.store.loadTasks(workflowId),
        { now: now(), retentionMs: IDLE_WORKFLOW_RETENTION_MS },
      );

      for (const action of actions) {
        if (ctx.signal?.aborted) return;
        if (!FORCE_DRY_RUN) {
          throw new Error('idle-task-cleanup live workflow retirement is not implemented');
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
    note: 'Dry-run: reports completed workflows immediately and inactive workflows older than 48 hours.',
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
        tickOnStart: config.tickOnStart,
        now: config.now,
      });
    },
  });
  return registry;
}
