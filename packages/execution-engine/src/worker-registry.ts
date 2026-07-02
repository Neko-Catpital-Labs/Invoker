/**
 * Worker registry: a single declaration surface for the long-running workers
 * Invoker can run.
 *
 * Each worker is declared once as a {@link WorkerDefinition} — its `kind`, an
 * operator-facing `note`, and a `factory` that builds the worker runtime from
 * injected dependencies. Today the only built-in is the auto-fix recovery
 * worker; centralizing worker knowledge here lets future workers be declared
 * uniformly instead of being implied by a single hard-coded auto-fix branch.
 */

import type { Logger } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';

import {
  createRecoveryWorker,
  type AutoFixRecoveryStore,
  type AutoFixRecoverySubmitter,
} from './auto-fix-recovery.js';
import type { WorkerRuntime } from './worker-runtime.js';

/** Registry kind for the built-in auto-fix recovery worker. */
export const AUTO_FIX_WORKER_KIND = 'autofix';

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
        },
      }),
  });
  return registry;
}
