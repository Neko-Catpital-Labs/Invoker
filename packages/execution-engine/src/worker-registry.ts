/**
 * Worker registry.
 *
 * Centralizes worker knowledge in one declaration surface. Instead of the
 * system implying a single worker through a hard-coded auto-fix branch, each
 * worker is declared as a {@link WorkerDefinition} keyed by `kind`, with a
 * factory that builds the worker runtime from injected dependencies.
 *
 * This slice is additive and behavior-neutral: it adds the registry primitive
 * and registers the existing auto-fix worker as the built-in default. Nothing
 * reaches the registry yet — the headless and CLI entry points keep building
 * the auto-fix worker directly, so runtime behavior is unchanged.
 */

import type { Logger } from '@invoker/contracts';
import { createAutoFixRecoveryWorker } from './auto-fix-recovery.js';
import type { WorkerRuntime } from './worker-runtime.js';

/** Registry kind for the built-in auto-fix worker. */
export const AUTO_FIX_WORKER_KIND = 'autofix';

/**
 * Default number of recovery attempts an auto-fix worker spends per failed
 * task. A behavior-neutral default for callers that do not override it.
 */
export const DEFAULT_AUTO_FIX_ATTEMPT_BUDGET = 1;

/**
 * Read/write access to the worker's persisted state across ticks. A worker
 * uses it to load prior progress and record what it did.
 */
export interface WorkerStateAccessor {
  read(): Promise<unknown> | unknown;
  write(state: unknown): Promise<void> | void;
}

/** Channel a worker emits operator-facing action output on. */
export interface WorkerActionOutputChannel {
  emit(line: string): void;
}

/** Auto-fix tuning a worker factory consumes when it builds a worker. */
export interface AutoFixWorkerConfig {
  /** Default number of fix attempts spent per failed task. */
  attemptBudget: number;
  /** Agent that performs the fix, when one is chosen. */
  agent?: string;
}

/** Dependencies injected into a {@link WorkerDefinition.factory}. */
export interface WorkerFactoryDeps {
  /** Persisted state accessor the worker reads/writes across ticks. */
  state: WorkerStateAccessor;
  /** Operator-facing action-output channel. */
  actionOutput: WorkerActionOutputChannel;
  logger: Logger;
  /** Auto-fix configuration: default attempt budget and chosen agent. */
  autoFix: AutoFixWorkerConfig;
}

/** Declaration of a single worker the system knows how to build. */
export interface WorkerDefinition {
  /** Worker family the registry keys on, e.g. {@link AUTO_FIX_WORKER_KIND}. */
  readonly kind: string;
  /** Human note surfaced in operator output. */
  readonly note: string;
  /** Build the worker runtime from injected dependencies. */
  readonly factory: (deps: WorkerFactoryDeps) => WorkerRuntime;
}

/** A registry of {@link WorkerDefinition}s keyed by `kind`. */
export interface WorkerRegistry {
  /** Register (or replace) the definition for its `kind`. */
  register(definition: WorkerDefinition): void;
  /** Look up a definition by `kind`. Returns `undefined` when absent. */
  get(kind: string): WorkerDefinition | undefined;
  /** Every registered definition, in registration order. */
  list(): WorkerDefinition[];
}

/** Create an empty {@link WorkerRegistry}. */
export function createWorkerRegistry(): WorkerRegistry {
  const definitions = new Map<string, WorkerDefinition>();
  return {
    register(definition: WorkerDefinition): void {
      definitions.set(definition.kind, definition);
    },
    get(kind: string): WorkerDefinition | undefined {
      return definitions.get(kind);
    },
    list(): WorkerDefinition[] {
      return [...definitions.values()];
    },
  };
}

/**
 * Register the built-in auto-fix worker on `registry` under
 * {@link AUTO_FIX_WORKER_KIND}. Reuses the existing auto-fix recovery worker
 * factory ({@link createAutoFixRecoveryWorker}) so building it stays
 * behavior-neutral — the scan is a no-op by default and no existing auto-fix
 * path is rerouted. The runtime owns its own lifetime, so the worker does not
 * install process signal handlers when built through the registry. Returns the
 * same registry for chaining.
 */
export function registerAutoFixWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register({
    kind: AUTO_FIX_WORKER_KIND,
    note: 'auto-fix recovery owner with audit-backed status',
    factory: (deps: WorkerFactoryDeps): WorkerRuntime =>
      createAutoFixRecoveryWorker({ logger: deps.logger, installSignalHandlers: false }),
  });
  return registry;
}
