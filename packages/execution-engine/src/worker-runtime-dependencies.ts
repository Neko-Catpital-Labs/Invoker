import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type {
  AutoApproveWorkerConfig,
  AutoApproveWorkerStore,
  AutoApproveWorkerSubmitter,
} from './workers/auto-approve-worker.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore & AutoApproveWorkerStore & CiFailureWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter & AutoApproveWorkerSubmitter & CiFailureWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** Auto-approval tuning for worker-owned AI fix approvals. */
  autoApprove?: AutoApproveWorkerConfig;
}
