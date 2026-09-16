import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const WORKFLOW_CLEANUP_WORKER_KIND = 'workflow-cleanup';
export const DEFAULT_WORKFLOW_CLEANUP_INTERVAL_MS = 5 * 60_000;

const CLEANUP_STATUSES = new Set(['completed', 'closed']);

export interface WorkflowCleanupWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string; status: string }>;
}

export interface WorkflowCleanupWorkerOptions {
  logger: Logger;
  store: WorkflowCleanupWorkerStore;
  deleteWorkflow: (workflowId: string) => void;
  intervalMs?: number;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function createWorkflowCleanupWorker(options: WorkflowCleanupWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: WORKFLOW_CLEANUP_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_WORKFLOW_CLEANUP_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal.throwIfAborted();

      const candidates = options.store.listWorkflows().filter((workflow) => CLEANUP_STATUSES.has(workflow.status));
      let deleted = 0;
      for (const workflow of candidates) {
        ctx.signal.throwIfAborted();
        try {
          options.deleteWorkflow(workflow.id);
          deleted += 1;
        } catch (error) {
          options.logger.error?.(`[${WORKFLOW_CLEANUP_WORKER_KIND}] failed to delete workflow ${workflow.id}`, {
            module: WORKFLOW_CLEANUP_WORKER_KIND,
            workflowId: workflow.id,
            error,
          });
        }
      }

      options.logger.info?.(
        `[${WORKFLOW_CLEANUP_WORKER_KIND}] cleanup pass: ${deleted}/${candidates.length} workflow(s) deleted`,
        { module: WORKFLOW_CLEANUP_WORKER_KIND, candidates: candidates.length, deleted },
      );
    },
  });
}

export function registerWorkflowCleanupWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: WORKFLOW_CLEANUP_WORKER_KIND,
    note: 'Deletes completed and closed workflows every five minutes on the owner host.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      if (!deps.deleteWorkflow || !deps.workflowCleanup) {
        throw new Error('workflow-cleanup worker requires owner workflow cleanup dependencies');
      }
      return createWorkflowCleanupWorker({
        logger: deps.logger,
        store: deps.workflowCleanup,
        deleteWorkflow: deps.deleteWorkflow,
      });
    },
  });
  return registry;
}
