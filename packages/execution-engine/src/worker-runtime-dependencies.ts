import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type {
  CodeRabbitAgentRunner,
  CodeRabbitUpdateWorkerStore,
} from './workers/coderabbit-update-worker.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { MergeConflictRebaseWorkerStore } from './workers/merge-conflict-rebase-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type { PrMaintenanceWorkerConfig, WorkerGitHubClient, WorkerMutationSubmitter } from './worker-types.js';

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore & CiFailureWorkerStore & CodeRabbitUpdateWorkerStore & MergeConflictRebaseWorkerStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter & CiFailureWorkerSubmitter & WorkerMutationSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** GitHub API surface used by PR-maintenance workers. Defaults to the gh CLI when absent. */
  github?: WorkerGitHubClient;
  /** PR-maintenance worker tuning shared by CodeRabbit and conflict workers. */
  prMaintenance?: PrMaintenanceWorkerConfig;
  /** Test/custom runner seam for CodeRabbit feedback updates. */
  codeRabbitRunner?: CodeRabbitAgentRunner;
}
