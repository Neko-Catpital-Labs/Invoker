import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { PrMaintenanceWorkerConfig } from './workers/pr-maintenance-workers.js';
import type { DiskHeadroomWorkerConfig } from './workers/disk-headroom-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type { PrSummaryRefreshWorkerConfig, PrSummaryRefreshWorkerStore } from './workers/pr-summary-refresh-worker.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore & CiFailureWorkerStore & PrSummaryRefreshWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter & CiFailureWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Review providers used by PR summary/maintenance workers. */
  reviewProviders?: ReviewProviderRegistry;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** PR-maintenance shell worker launch configuration. */
  prMaintenance?: PrMaintenanceWorkerConfig;
  /** PR summary refresh worker configuration. */
  prSummaryRefresh?: PrSummaryRefreshWorkerConfig;
  /** Disk-headroom worker configuration (local/remote paths and thresholds). */
  diskHeadroom?: DiskHeadroomWorkerConfig;
}
