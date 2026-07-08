import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { DiskHeadroomWorkerConfig } from './workers/disk-headroom-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type {
  PrMaintenanceAutomationConfig,
} from './worker-types.js';
import type { CoderabbitUpdateWorkerStore } from './workers/coderabbit-update-worker.js';
import type { MergeConflictRebaseWorkerStore } from './workers/merge-conflict-rebase-worker.js';
import type { PrSummaryRefreshWorkerStore } from './workers/pr-summary-refresh-worker.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore & CiFailureWorkerStore & CoderabbitUpdateWorkerStore & MergeConflictRebaseWorkerStore & PrSummaryRefreshWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter & CiFailureWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** Built-in PR maintenance worker configuration. */
  prMaintenance?: PrMaintenanceAutomationConfig;
  /** Disk-headroom worker configuration (local/remote paths and thresholds). */
  diskHeadroom?: DiskHeadroomWorkerConfig;
}
