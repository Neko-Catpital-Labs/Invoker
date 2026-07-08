import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import type {
  AutoFixRecoveryStore,
  AutoFixRecoverySubmitter,
  AutoFixWorkerConfig,
} from './auto-fix-recovery.js';
import type { CiFailureWorkerStore, CiFailureWorkerSubmitter } from './workers/ci-failure-worker.js';
import type { PrStatusReviewGate } from './workers/pr-status-worker.js';
import type {
  WorkerGitHubClient,
  WorkerHeadlessClient,
  WorkerStateStore,
} from './worker-types.js';
import type { CodeRabbitUpdateAgent } from './workers/coderabbit-update-worker.js';
import type { MergeGateProvider } from './merge-gate-provider.js';

export interface PrMaintenanceWorkerConfig {
  targetRepo?: string;
  author?: string;
  coderabbit?: {
    login?: string;
    maxAttempts?: number;
    workDir?: string;
    executionAgent?: string;
    executionModel?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  mergeConflict?: {
    maxAttempts?: number;
    confirmTimeoutMs?: number;
    confirmPollIntervalMs?: number;
    pollIntervalMs?: number;
  };
}

/** Dependencies injected into a built-in worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore & CiFailureWorkerStore & WorkerStateStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter & CiFailureWorkerSubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Review-gate polling surface owned by the task runner. */
  reviewGate?: PrStatusReviewGate;
  /** Review provider used by PR maintenance workers that update PR metadata. */
  mergeGateProvider?: MergeGateProvider;
  /** Repository working directory for provider CLIs. */
  cwd?: string;
  /** Auto-fix tuning shared by workers that submit fix intents. */
  autoFix?: AutoFixWorkerConfig;
  /** GitHub PR/comment surface used by PR maintenance workers. */
  github?: WorkerGitHubClient;
  /** Headless command transport used by PR maintenance workers. */
  headless?: WorkerHeadlessClient;
  /** Agent runner used to address CodeRabbit feedback. */
  codeRabbitUpdateAgent?: CodeRabbitUpdateAgent;
  /** PR maintenance worker tuning. */
  prMaintenance?: PrMaintenanceWorkerConfig;
}
