import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type { AutoFixAttemptLedger } from './auto-fix-attempt-ledger.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { ReviewGateCiRepairStore, ReviewGateCiRepairSubmitter } from './review-gate-ci-repair.js';
import type {
  ReviewGateMergeConflictWorkerStore,
  ReviewGateMergeConflictWorkerSubmitter,
} from './workers/review-gate-merge-conflict-worker.js';

export interface AutoFixWorkerConfig {
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  attemptLedger?: AutoFixAttemptLedger;
}

export interface WorkerRuntimeDependencies {
  store: CiFailureWorkerStore
    & ReviewGateCiRepairStore
    & ReviewGateMergeConflictWorkerStore;
  submitter: CiFailureWorkerSubmitter
    & ReviewGateCiRepairSubmitter
    & ReviewGateMergeConflictWorkerSubmitter;
  logger: Logger;
  messageBus?: MessageBus;
  reviewGate?: PrStatusReviewGate;
  autoFix?: AutoFixWorkerConfig;
}
