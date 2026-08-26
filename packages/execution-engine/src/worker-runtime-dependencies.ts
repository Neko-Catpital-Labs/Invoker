import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type { MergeGateProvider } from './merge-gate-provider.js';
import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type { ReviewGateCiRepairStore, ReviewGateCiRepairSubmitter } from './review-gate-ci-repair.js';
import type {
  AutoApproveWorkerStore,
  AutoApproveWorkerSubmitter,
  AutoApproveWorkerConfig,
} from './workers/auto-approve-worker.js';
import type { PrMaintenanceWorkerConfig } from './workers/pr-maintenance-workers.js';
import type { E2eAutoFixWorkerConfig } from './workers/e2e-autofix-worker.js';
import type { DiskHeadroomWorkerConfig } from './workers/disk-headroom-worker.js';
import type { ClaudeOauthRefreshWorkerConfig } from './workers/claude-oauth-refresh-worker.js';
import type { DiskHeadroomWorkerStore } from './workers/disk-headroom-reclaim.js';
import type { SlackBugScanWorkerConfig } from './workers/slack-bug-scan-worker.js';
import type { CrossRepoResearchWorkerConfig } from './workers/cross-repo-research-worker.js';
import type { CatstackDeployWorkerConfig } from './workers/catstack-deploy-worker.js';
import type { MergifyQueueResearchWorkerConfig } from './workers/mergify-queue-research-worker.js';
import type {
  InfraRepairWorkerConfig,
  InfraRepairWorkerStore,
  InfraRepairWorkerSubmitter,
} from './workers/infra-repair-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type { RequeueWorkerConfig, RequeueWorkerSubmitter } from './workers/requeue-worker.js';
import type {
  WorkflowResumeWorkerConfig,
  WorkflowResumeWorkerStore,
  WorkflowResumeWorkerSubmitter,
} from './workers/workflow-resume-worker.js';
import type {
  IdleTaskCleanupWorkerConfig,
  IdleTaskCleanupWorkerStore,
  IdleTaskCleanupWorkerSubmitter,
} from './workers/idle-task-cleanup-worker.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore
    & ReviewGateCiRepairStore
    & AutoApproveWorkerStore
    & InfraRepairWorkerStore
    & WorkflowResumeWorkerStore
    & DiskHeadroomWorkerStore
    & IdleTaskCleanupWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter
    & ReviewGateCiRepairSubmitter
    & RequeueWorkerSubmitter
    & AutoApproveWorkerSubmitter
    & InfraRepairWorkerSubmitter
    & WorkflowResumeWorkerSubmitter
    & IdleTaskCleanupWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Provider IO surface for workers that need to update published reviews. */
  mergeGateProvider?: MergeGateProvider;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** Requeue worker tuning (stall requeue budget / backoff). */
  requeue?: RequeueWorkerConfig;
  /** PR-maintenance shell worker launch configuration. */
  prMaintenance?: PrMaintenanceWorkerConfig;
  /** Disk-headroom worker configuration (local/remote paths and thresholds). */
  diskHeadroom?: DiskHeadroomWorkerConfig;
  /** Claude OAuth refresh worker configuration (local credentials path and SSH pool distribution targets). */
  claudeOauthRefresh?: ClaudeOauthRefreshWorkerConfig;
  /** Infra-repair worker configuration (owner/local repo plus remote SSH repair targets). */
  infraRepair?: InfraRepairWorkerConfig;
  /** Auto-approval tuning for worker-owned AI fix approvals. */
  autoApprove?: AutoApproveWorkerConfig;
  /** Workflow-resume worker tuning (cooldown and poll cadence). */
  workflowResume?: WorkflowResumeWorkerConfig;
  /** e2e auto-fix/default-branch CI watcher configuration. */
  e2eAutoFix?: E2eAutoFixWorkerConfig;
  slackBugScan?: SlackBugScanWorkerConfig;
  /** Cross-repo research worker configuration. */
  crossRepoResearch?: CrossRepoResearchWorkerConfig;
  /** Catstack deploy worker configuration (local + remoteTargets clone/pull/install). */
  catstackDeploy?: CatstackDeployWorkerConfig;
  /** Mergify queue research worker configuration. */
  mergifyQueueResearch?: MergifyQueueResearchWorkerConfig;
  /** Idle-task-cleanup worker configuration (dry-run only; see the worker's own docs). */
  idleTaskCleanup?: IdleTaskCleanupWorkerConfig;
}
