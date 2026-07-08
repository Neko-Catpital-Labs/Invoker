import { registerAutoFixWorker } from './auto-fix-recovery.js';
import type { WorkerRuntimeDependencies } from './worker-runtime-dependencies.js';
import type { WorkerRegistry } from './worker-registry.js';
import { registerCiFailureWorker } from './workers/ci-failure-worker.js';
import { registerDiskHeadroomWorker } from './workers/disk-headroom-worker.js';
import { registerPrMaintenanceWorkers } from './workers/pr-maintenance-workers.js';
import { registerPrStatusWorker } from './workers/pr-status-worker.js';
import { registerRequeueWorker } from './workers/requeue-worker.js';

/** Register every built-in worker in the stable built-in order. */
export function registerBuiltinWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerAutoFixWorker(registry);
  registerRequeueWorker(registry);
  registerPrStatusWorker(registry);
  registerCiFailureWorker(registry);
  registerDiskHeadroomWorker(registry);
  registerPrMaintenanceWorkers(registry);
  return registry;
}
