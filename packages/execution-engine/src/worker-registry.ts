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
  /** Registration source surfaced in read-only snapshots. */
  readonly source?: 'built-in' | 'external';
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
