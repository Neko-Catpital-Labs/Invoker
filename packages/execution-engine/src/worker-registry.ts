/**
 * Worker registry: a single declaration surface for the long-running workers
 * Invoker can run.
 *
 * Each worker is declared once as a {@link WorkerDefinition} — its `kind`, an
 * operator-facing `note`, and a `factory` that builds the worker runtime from
 * injected dependencies. Centralizing worker knowledge here keeps owner-mode
 * polling and external worker commands on the same registry surface.
 */

import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import {
  createRecoveryWorker,
  type AutoFixRecoveryStore,
  type AutoFixRecoverySubmitter,
} from './auto-fix-recovery.js';
import { createPrStatusWorker, PR_STATUS_WORKER_KIND } from './workers/pr-status-worker.js';
import type { WorkerRuntime } from './worker-runtime.js';

/** Registry kind for the built-in auto-fix recovery worker. */
export const AUTO_FIX_WORKER_KIND = 'autofix';
export { PR_STATUS_WORKER_KIND };

/** Auto-fix tuning handed to a worker factory. */
export interface AutoFixWorkerConfig {
  /** Default attempt budget when a task does not override it. */
  defaultAutoFixRetries?: number;
  /** Resolves the agent that performs each auto-fix, when one is configured. */
  getAutoFixAgent?: () => string | undefined;
}

/** Dependencies injected into a worker factory when its runtime is built. */
export interface WorkerRuntimeDependencies {
  /** Persisted workflow/task state accessor. */
  store: AutoFixRecoveryStore;
  /** Action-output channel used to submit follow-up mutation intents. */
  submitter: AutoFixRecoverySubmitter;
  /** Operator logger. */
  logger: Logger;
  /** Optional bus that turns lifecycle events into immediate wakeups. */
  messageBus?: MessageBus;
  /** Auto-fix tuning. */
  autoFix?: AutoFixWorkerConfig;
  /** Review-gate polling surface for the PR status worker. */
  reviewGate?: { checkMergeGateStatuses(): void | Promise<void> };
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
 * Register the built-in workers. The legacy function name is kept so existing
 * headless code and tests keep the same import path while the registry now
 * includes auto-fix and pr-status entries.
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
        },
      }),
  });
  registry.register({
    kind: PR_STATUS_WORKER_KIND,
    note: 'Polls review-gate PR statuses through the registered merge-gate provider.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      if (!deps.reviewGate) throw new Error('pr-status worker requires reviewGate deps');
      return createPrStatusWorker({ logger: deps.logger, reviewGate: deps.reviewGate });
    },
  });
  return registry;
}
