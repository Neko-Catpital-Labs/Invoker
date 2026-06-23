/**
 * Auto-fix recovery worker.
 *
 * Thin, behavior-neutral entry point that builds the generic recovery worker
 * (`createRecoveryWorker`) for the auto-fix family. Standing this worker up is
 * behavior-neutral: by default its scan is a no-op, so existing auto-fix paths
 * keep running through their current owner and nothing is rerouted here.
 *
 * This module is the single shared home for the auto-fix recovery engine so it
 * can be imported by both `@invoker/app` and `@invoker/cli` (which does not
 * depend on `@invoker/app`).
 */

import type { Logger } from '@invoker/contracts';
import {
  createRecoveryWorker,
  type RecoveryWorkerOptions,
  type WorkerRuntime,
  type WorkerTick,
} from './worker-runtime.js';

/**
 * Lifecycle wakeup channel the auto-fix recovery worker listens on. Lifecycle
 * publishers raise this channel to request an out-of-cadence recovery scan.
 */
export const AUTO_FIX_RECOVERY_CHANNEL = 'auto-fix-recovery';

export interface AutoFixRecoveryScanOptions {
  logger: Logger;
}

/**
 * Build the scan (tick) the auto-fix recovery worker runs. The scan is the unit
 * of work that discovers eligible failed tasks and would submit recovery
 * commands. It is a behavior-neutral no-op by default so relocating the engine
 * does not change runtime behavior.
 */
export function createAutoFixRecoveryScan(_options: AutoFixRecoveryScanOptions): WorkerTick {
  return () => {};
}

/** Options for {@link createAutoFixRecoveryWorker}. */
export type AutoFixRecoveryWorkerOptions = RecoveryWorkerOptions;

/**
 * Create the auto-fix recovery worker runtime. Wraps the generic recovery
 * worker with the auto-fix scan. Behavior-neutral by default: the scan is a
 * no-op unless an explicit `onTick` is supplied.
 */
export function createAutoFixRecoveryWorker(options: AutoFixRecoveryWorkerOptions): WorkerRuntime {
  return createRecoveryWorker({
    ...options,
    onTick: options.onTick ?? createAutoFixRecoveryScan({ logger: options.logger }),
  });
}
