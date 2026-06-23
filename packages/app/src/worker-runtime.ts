/**
 * Re-export shim. The worker-runtime engine now lives in
 * `@invoker/execution-engine` so it can be shared with packages (e.g.
 * `@invoker/cli`) that do not depend on `@invoker/app`. This file keeps every
 * previous `./worker-runtime.js` import in `@invoker/app` resolving unchanged.
 */
export {
  createWorkerRuntime,
  createRecoveryWorker,
  RECOVERY_WORKER_KIND,
} from '@invoker/execution-engine';

export type {
  WorkerTickReason,
  WorkerIdentity,
  WorkerTickContext,
  WorkerTick,
  WorkerRuntimeOptions,
  WorkerRuntime,
  RecoveryWorkerOptions,
} from '@invoker/execution-engine';
