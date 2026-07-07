import { registerAutoFixWorker } from './auto-fix-recovery.js';
import type { WorkerRuntimeDependencies } from './worker-runtime-dependencies.js';
import type { WorkerRegistry } from './worker-registry.js';
import { registerCiFailureWorker } from './workers/ci-failure-worker.js';
import { registerGitHubPrEventsWorker } from './workers/github-pr-events-worker.js';
import { registerPrMaintenanceWorkers } from './workers/pr-maintenance-workers.js';
import { registerPrStatusWorker } from './workers/pr-status-worker.js';

/** Register every built-in worker in the stable built-in order. */
export function registerBuiltinWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerAutoFixWorker(registry);
  registerPrStatusWorker(registry);
  registerCiFailureWorker(registry);
  registerGitHubPrEventsWorker(registry);
  registerPrMaintenanceWorkers(registry);
  return registry;
}
