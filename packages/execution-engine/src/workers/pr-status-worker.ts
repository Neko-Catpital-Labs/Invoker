import type { Logger } from '@invoker/contracts';

import { createWorkerRuntime, type WorkerRuntime } from '../worker-runtime.js';

export const PR_STATUS_WORKER_KIND = 'pr-status';
export const DEFAULT_PR_STATUS_WORKER_INTERVAL_MS = 60_000;

export interface PrStatusWorkerReviewGateDeps {
  checkMergeGateStatuses(): void | Promise<void>;
}

export interface PrStatusWorkerOptions {
  logger: Logger;
  reviewGate: PrStatusWorkerReviewGateDeps;
  instanceId?: string;
  intervalMs?: number;
  tickOnStart?: boolean;
  installSignalHandlers?: boolean;
}

export function createPrStatusWorker(options: PrStatusWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_STATUS_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: async () => {
      await options.reviewGate.checkMergeGateStatuses();
    },
  });
}
