import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
export const PR_STATUS_WORKER_KIND = 'pr-status';
export const DEFAULT_PR_STATUS_WORKER_INTERVAL_MS = 60_000;

export interface PrStatusReviewGate {
  checkMergeGateStatuses(): void | Promise<void>;
}

export interface PrStatusWorkerPolicyOptions {
  reviewGate?: PrStatusReviewGate;
  logger: Logger;
}

export interface PrStatusWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  reviewGate?: PrStatusReviewGate;
  onTick?: WorkerTick;
}
/** Register the built-in PR status worker. */
export function registerPrStatusWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_STATUS_WORKER_KIND,
    note: 'Polls review-gate PR status through the registered TaskRunner review-gate check.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrStatusWorker({
        logger: deps.logger,
        reviewGate: deps.reviewGate,
      }),
  });
  return registry;
}


export function createPrStatusTick(options: PrStatusWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.reviewGate) {
      options.logger.debug?.('[worker:pr-status] review gate dependency unavailable', {
        module: 'pr-status-worker',
      });
      return;
    }
    await options.reviewGate.checkMergeGateStatuses();
  };
}

export function createPrStatusWorker(options: PrStatusWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_STATUS_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrStatusTick({
      logger: options.logger,
      reviewGate: options.reviewGate,
    }),
  });
}
