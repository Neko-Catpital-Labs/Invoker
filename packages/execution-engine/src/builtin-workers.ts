import { registerAutoFixWorker } from './auto-fix-recovery.js';
import { registerAutoApproveWorker } from './workers/auto-approve-worker.js';
import type { WorkerRuntimeDependencies } from './worker-runtime-dependencies.js';
import type { WorkerRegistry } from './worker-registry.js';
import { registerCiFailureWorker } from './workers/ci-failure-worker.js';
import { registerE2eAutoFixWorker } from './workers/e2e-autofix-worker.js';
import { registerDiskHeadroomWorker } from './workers/disk-headroom-worker.js';
import { registerPrMaintenanceWorkers } from './workers/pr-maintenance-workers.js';
import { registerPrStatusWorker } from './workers/pr-status-worker.js';
import { registerRequeueWorker } from './workers/requeue-worker.js';
import { registerReviewGateMergeConflictWorker } from './workers/review-gate-merge-conflict-worker.js';
import { registerWorkflowResumeWorker } from './workers/workflow-resume-worker.js';

/** Register every built-in worker in the stable built-in order. */
export function registerBuiltinWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerAutoFixWorker(registry);
  registerRequeueWorker(registry);
  registerWorkflowResumeWorker(registry);
  registerPrStatusWorker(registry);
  registerCiFailureWorker(registry);
  registerReviewGateMergeConflictWorker(registry);
  registerDiskHeadroomWorker(registry);
  registerAutoApproveWorker(registry);
  registerPrMaintenanceWorkers(registry);
  registerE2eAutoFixWorker(registry);
  return registry;
}
