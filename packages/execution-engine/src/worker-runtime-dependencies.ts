import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type {
  AutoApproveWorkerStore,
  AutoApproveWorkerSubmitter,
  AutoApproveWorkerConfig,
} from './workers/auto-approve-worker.js';
import type { PrMaintenanceWorkerConfig } from './workers/pr-maintenance-workers.js';
import type { E2eAutoFixWorkerConfig } from './workers/e2e-autofix-worker.js';
import type { DiskHeadroomWorkerConfig } from './workers/disk-headroom-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type {
  ReviewGateMergeConflictWorkerStore,
  ReviewGateMergeConflictWorkerSubmitter,
} from './workers/review-gate-merge-conflict-worker.js';
import type { RequeueWorkerConfig, RequeueWorkerSubmitter } from './workers/requeue-worker.js';
import type {
  WorkflowResumeWorkerConfig,
  WorkflowResumeWorkerStore,
  WorkflowResumeWorkerSubmitter,
} from './workers/workflow-resume-worker.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore
    & CiFailureWorkerStore
    & AutoApproveWorkerStore
    & ReviewGateMergeConflictWorkerStore
    & WorkflowResumeWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter
    & CiFailureWorkerSubmitter
    & RequeueWorkerSubmitter
    & AutoApproveWorkerSubmitter
    & ReviewGateMergeConflictWorkerSubmitter
    & WorkflowResumeWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** Requeue worker tuning (stall requeue budget / backoff). */
  requeue?: RequeueWorkerConfig;
  /** PR-maintenance shell worker launch configuration. */
  prMaintenance?: PrMaintenanceWorkerConfig;
  /** Disk-headroom worker configuration (local/remote paths and thresholds). */
  diskHeadroom?: DiskHeadroomWorkerConfig;
  /** Auto-approval tuning for worker-owned AI fix approvals. */
  autoApprove?: AutoApproveWorkerConfig;
  /** Workflow-resume worker tuning (cooldown and poll cadence). */
  workflowResume?: WorkflowResumeWorkerConfig;
  /** e2e auto-fix battery worker configuration. */
  e2eAutoFix?: E2eAutoFixWorkerConfig;
}
