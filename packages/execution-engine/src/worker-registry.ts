/**
 * Worker registry: a single declaration surface for the long-running workers
 * Invoker can run.
 *
 * Each worker is declared once as a {@link WorkerDefinition} — its `kind`, an
 * operator-facing `note`, and a `factory` that builds the worker runtime from
 * injected dependencies. Centralizing worker knowledge here keeps all built-in
 * workers on one declaration path instead of scattering hard-coded branches
 * across the app and CLI doors.
 */

import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import {
  createRecoveryWorker,
  type AutoFixRecoveryStore,
  type AutoFixRecoverySubmitter,
} from './auto-fix-recovery.js';
import {
  AUTO_APPROVE_WORKER_KIND,
  createAutoApproveWorker,
  type AutoApproveWorkerSubmitter,
  type AutoApproveWorkerStore,
} from './workers/auto-approve-worker.js';
import {
  PR_STATUS_WORKER_KIND,
  createPrStatusWorker,
  type PrStatusReviewGate,
} from './workers/pr-status-worker.js';
import {
  CI_FAILURE_WORKER_KIND,
  createCiFailureWorker,
  type CiFailureWorkerStore,
  type CiFailureWorkerSubmitter,
} from './workers/ci-failure-worker.js';
import type { WorkerRuntime } from './worker-runtime.js';

export { AUTO_APPROVE_WORKER_KIND } from './workers/auto-approve-worker.js';
export { PR_STATUS_WORKER_KIND } from './workers/pr-status-worker.js';
export { CI_FAILURE_WORKER_KIND } from './workers/ci-failure-worker.js';

/** Registry kind for the built-in auto-fix recovery worker. */
export const AUTO_FIX_WORKER_KIND = 'autofix';

/** Auto-fix tuning handed to a worker factory. */
export interface AutoFixWorkerConfig {
  /** Default attempt budget when a task does not override it. */
  defaultAutoFixRetries?: number;
  /** Resolves the agent that performs each auto-fix, when one is configured. */
  getAutoFixAgent?: () => string | undefined;
  /** Resolves the execution model passed to auto-fix agent commands. */
  getAutoFixExecutionModel?: () => string | undefined;
}

/** Auto-approval tuning handed to a worker factory. */
export interface AutoApproveWorkerConfig {
  /** Returns true when AI-applied fixes should be approved by the worker. */
  getAutoApproveAIFixes?: () => boolean | undefined;
}

/** Dependencies injected into a worker factory when its runtime is built. */
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
  /** Auto-fix tuning. */
  autoFix?: AutoFixWorkerConfig;
  /** Auto-approval tuning. */
  autoApprove?: AutoApproveWorkerConfig;
}

/** Builds a worker runtime from injected dependencies. */
export type WorkerFactory = (deps: WorkerRuntimeDependencies) => WorkerRuntime;

/** A single worker declared in the registry. */
export interface WorkerDefinition {
  /** Stable registry kind, e.g. `'autofix'`. */
  readonly kind: string;
  /** Human-readable note surfaced in operator output. */
  readonly note: string;
  /** Builds the worker runtime from injected dependencies. */
  readonly factory: WorkerFactory;
}

/** Mutable collection of worker definitions keyed by kind. */
export interface WorkerRegistry {
  /** Register (or replace) a definition by its kind. */
  register(definition: WorkerDefinition): void;
  /** Look up a definition by kind, or `undefined` when none is registered. */
  get(kind: string): WorkerDefinition | undefined;
  /** Every registered definition, in registration order. */
  list(): WorkerDefinition[];
}

/** Create an empty worker registry. */
export function createWorkerRegistry(): WorkerRegistry {
  const byKind = new Map<string, WorkerDefinition>();
  return {
    register(definition: WorkerDefinition): void {
      byKind.set(definition.kind, definition);
    },
    get(kind: string): WorkerDefinition | undefined {
      return byKind.get(kind);
    },
    list(): WorkerDefinition[] {
      return [...byKind.values()];
    },
  };
}

/**
 * Register the built-in auto-fix worker under {@link AUTO_FIX_WORKER_KIND},
 * reusing the existing recovery worker factory ({@link createRecoveryWorker})
 * so the runtime it builds behaves exactly as the auto-fix path always has.
 * Returns the registry so calls can be chained with {@link createWorkerRegistry}.
 */
export function registerAutoFixWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register({
    kind: AUTO_FIX_WORKER_KIND,
    note: 'Auto-fixes failed tasks by submitting fix-with-agent recovery intents.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createRecoveryWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        autoFix: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          getAutoFixExecutionModel: deps.autoFix?.getAutoFixExecutionModel,
        },
      }),
  });
  return registry;
}

/** Register the built-in auto-approval worker. */
export function registerAutoApproveWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register({
    kind: AUTO_APPROVE_WORKER_KIND,
    note: 'Approves AI-applied fixes that are awaiting approval when enabled.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createAutoApproveWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        autoApprove: {
          store: deps.store,
          submitter: deps.submitter,
          getAutoApproveAIFixes: deps.autoApprove?.getAutoApproveAIFixes,
        },
      }),
  });
  return registry;
}

/** Register the built-in PR status worker. */
export function registerPrStatusWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register({
    kind: PR_STATUS_WORKER_KIND,
    note: 'Polls review-gate PR status through the registered TaskRunner review-gate check.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrStatusWorker({
        logger: deps.logger,
        reviewGate: deps.reviewGate,
      }),
  });
  return registry;
}

/** Register the built-in CI-failure repair worker. */
export function registerCiFailureWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register({
    kind: CI_FAILURE_WORKER_KIND,
    note: 'Submits head-SHA guarded CI repair intents for failed review-gate checks.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCiFailureWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        ciFailure: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          getAutoFixExecutionModel: deps.autoFix?.getAutoFixExecutionModel,
        },
      }),
  });
  return registry;
}

/** Register every built-in worker in the stable built-in order. */
export function registerBuiltinWorkers(registry: WorkerRegistry): WorkerRegistry {
  registerAutoFixWorker(registry);
  registerAutoApproveWorker(registry);
  registerPrStatusWorker(registry);
  registerCiFailureWorker(registry);
  return registry;
}
