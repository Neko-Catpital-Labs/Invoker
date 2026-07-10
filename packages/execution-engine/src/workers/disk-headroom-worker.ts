import type { Logger } from '@invoker/contracts';

import { resolveInvokerHomeRoot } from '../worker-lock.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

import {
  resolveDiskCheckIntervalMs,
  resolveDiskHeadroomThresholds,
  type DiskHeadroomThresholds,
} from './disk-headroom.js';
import {
  runDiskHeadroomCheck,
  type DiskHeadroomMonitorDeps,
  type RemoteDiskTarget,
} from './disk-headroom-monitor.js';

export const DISK_HEADROOM_WORKER_KIND = 'disk-headroom';

export interface DiskHeadroomWorkerConfig {
  /** Local path to check. Defaults to resolveInvokerHomeRoot(). */
  localPath?: string;
  /** Remote SSH targets to check. Defaults to none. */
  remoteTargets?: RemoteDiskTarget[];

  thresholds?: DiskHeadroomThresholds;
  intervalMs?: number;
  tickOnStart?: boolean;

  /** Test seam: override the check runner. */
  runCheck?: (deps: DiskHeadroomMonitorDeps) => Promise<unknown>;
  /** Test seam: wrap the worker tick for observability. */
  onTick?: WorkerTick;
}

export interface DiskHeadroomWorkerOptions {
  logger: Logger;
  localPath: string;
  remoteTargets: RemoteDiskTarget[];
  thresholds?: DiskHeadroomThresholds;
  intervalMs?: number;
  tickOnStart?: boolean;
  runCheck?: (deps: DiskHeadroomMonitorDeps) => Promise<unknown>;
  onTick?: WorkerTick;
}

export function createDiskHeadroomWorker(options: DiskHeadroomWorkerOptions): WorkerRuntime {
  const runCheck = options.runCheck ?? runDiskHeadroomCheck;

  return createWorkerRuntime({
    kind: DISK_HEADROOM_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? resolveDiskCheckIntervalMs(),
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      if (ctx.signal?.aborted) return;
      await options.onTick?.(ctx);
      if (ctx.signal?.aborted) return;

      const thresholds = options.thresholds ?? resolveDiskHeadroomThresholds();
      await runCheck({
        logger: options.logger,
        thresholds,
        localPath: options.localPath,
        remoteTargets: options.remoteTargets,
      });
    },
  });
}

/** Register the built-in disk-headroom worker (best-effort `df` checks only). */
export function registerDiskHeadroomWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: DISK_HEADROOM_WORKER_KIND,
    note: 'Monitors local and remote disk usage, logging warnings at high utilization.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.diskHeadroom;
      return createDiskHeadroomWorker({
        logger: deps.logger,
        localPath: config?.localPath ?? resolveInvokerHomeRoot(),
        remoteTargets: config?.remoteTargets ?? [],
        thresholds: config?.thresholds,
        intervalMs: config?.intervalMs,
        tickOnStart: config?.tickOnStart,
        runCheck: config?.runCheck,
        onTick: config?.onTick,
      });
    },
  });
  return registry;
}
