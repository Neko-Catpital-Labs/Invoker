import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_STATUS_WORKER_KIND = 'pr-status';
export const DEFAULT_PR_STATUS_WORKER_INTERVAL_MS = 60_000;

export interface PrStatusReviewGate {
  checkMergeGateStatuses(): void | Promise<void>;
}

export interface PrStatusWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  reviewGate?: PrStatusReviewGate;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function registerPrStatusWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_STATUS_WORKER_KIND,
    note: 'Polls review-gate provider status for open merge tasks.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrStatusWorker({
        logger: deps.logger,
        reviewGate: deps.reviewGate,
      }),
  });
  return registry;
}

export function createPrStatusWorker(options: PrStatusWorkerOptions): WorkerRuntime {
  const onTick = options.onTick ?? (async () => {
    await options.reviewGate?.checkMergeGateStatuses();
  });
  return createWorkerRuntime({
    kind: PR_STATUS_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
}
