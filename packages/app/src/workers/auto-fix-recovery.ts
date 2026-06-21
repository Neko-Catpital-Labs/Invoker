import type { Logger } from '@invoker/contracts';

import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

/** Public worker kind for the auto-fix recovery worker. */
export const RECOVERY_WORKER_KIND = 'recovery';

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;

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
