import type { WorkerRuntime } from './worker-runtime.js';

/**
 * Worker registry: a generic catalog of long-running worker definitions.
 *
 * The registry itself is intentionally worker-agnostic. Built-in worker wiring
 * lives beside each worker implementation, while this file only manages lookup
 * and registration by stable kind.
 */

/** Builds a worker runtime from injected dependencies. */
export type WorkerFactory<TDeps = unknown> = (deps: TDeps) => WorkerRuntime;

/** A single worker declared in the registry. */
export interface WorkerDefinition<TDeps = unknown> {
  /** Stable registry kind, e.g. `'autofix'`. */
  readonly kind: string;
  /** Human-readable note surfaced in operator output. */
  readonly note: string;
  /** Builds the worker runtime from injected dependencies. */
  readonly factory: WorkerFactory<TDeps>;
}

/** Mutable collection of worker definitions keyed by kind. */
export interface WorkerRegistry<TDeps = unknown> {
  /** Register (or replace) a definition by its kind. */
  register(definition: WorkerDefinition<TDeps>): void;
  /** Look up a definition by kind, or `undefined` when none is registered. */
  get(kind: string): WorkerDefinition<TDeps> | undefined;
  /** Every registered definition, in registration order. */
  list(): WorkerDefinition<TDeps>[];
}

/** Create an empty worker registry. */
export function createWorkerRegistry<TDeps = unknown>(): WorkerRegistry<TDeps> {
  const byKind = new Map<string, WorkerDefinition<TDeps>>();
  return {
    register(definition: WorkerDefinition<TDeps>): void {
      byKind.set(definition.kind, definition);
    },
    get(kind: string): WorkerDefinition<TDeps> | undefined {
      return byKind.get(kind);
    },
    list(): WorkerDefinition<TDeps>[] {
      return [...byKind.values()];
    },
  };
}

export {
  CODERABBIT_UPDATE_WORKER_KIND,
  DEFAULT_CODERABBIT_AUTHOR,
  DEFAULT_CODERABBIT_EXECUTION_AGENT,
  DEFAULT_CODERABBIT_LOGIN,
  DEFAULT_CODERABBIT_MAX_ATTEMPTS,
  DEFAULT_CODERABBIT_TARGET_REPO,
  DEFAULT_CODERABBIT_TIMEOUT_MS,
  DEFAULT_CODERABBIT_WORK_DIR,
  coderabbitActionKey,
  collectCoderabbitComments,
  createCoderabbitUpdateTick,
  createCoderabbitUpdateWorker,
  createGhCliWorkerGitHubClient,
  parseTargetRepo,
  registerCoderabbitUpdateWorker,
  runPrMaintenanceCommand,
} from './workers/coderabbit-update-worker.js';
export {
  DEFAULT_MERGE_CONFLICT_AUTHOR,
  DEFAULT_MERGE_CONFLICT_CONFIRM_POLL_INTERVAL_MS,
  DEFAULT_MERGE_CONFLICT_CONFIRM_TIMEOUT_MS,
  DEFAULT_MERGE_CONFLICT_MAX_ATTEMPTS,
  DEFAULT_MERGE_CONFLICT_TARGET_REPO,
  MERGE_CONFLICT_REBASE_WORKER_KIND,
  createMergeConflictRebaseTick,
  createMergeConflictRebaseWorker,
  mergeConflictManualAttentionKey,
  mergeConflictRebaseActionKey,
  registerMergeConflictRebaseWorker,
} from './workers/merge-conflict-rebase-worker.js';
