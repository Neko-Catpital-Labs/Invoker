/**
 * Re-export shim. The auto-fix recovery worker engine now lives in
 * `@invoker/execution-engine` so it can be shared with packages (e.g.
 * `@invoker/cli`) that do not depend on `@invoker/app`. This file keeps every
 * previous `./auto-fix-recovery.js` import in `@invoker/app` resolving unchanged.
 */
export {
  AUTO_FIX_RECOVERY_CHANNEL,
  createAutoFixRecoveryScan,
  createAutoFixRecoveryWorker,
} from '@invoker/execution-engine';

export type {
  AutoFixRecoveryScanOptions,
  AutoFixRecoveryWorkerOptions,
} from '@invoker/execution-engine';
