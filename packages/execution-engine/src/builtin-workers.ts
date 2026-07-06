import { AUTO_FIX_WORKER_KIND, registerAutoFixWorker } from './auto-fix-recovery.js';
import type { WorkerRuntimeDependencies } from './worker-runtime-dependencies.js';
import type { WorkerRegistry } from './worker-registry.js';
import { CI_FAILURE_WORKER_KIND, registerCiFailureWorker } from './workers/ci-failure-worker.js';
import { PR_STATUS_WORKER_KIND, registerPrStatusWorker } from './workers/pr-status-worker.js';

export const BUILTIN_WORKER_KINDS = [
  AUTO_FIX_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
] as const;

/** Register every built-in worker in the stable built-in order. */
export function registerBuiltinWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerAutoFixWorker(registry);
  registerPrStatusWorker(registry);
  registerCiFailureWorker(registry);
  return registry;
}
