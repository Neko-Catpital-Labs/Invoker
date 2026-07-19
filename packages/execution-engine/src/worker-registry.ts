import type { WorkerRuntime } from './worker-runtime.js';

export type WorkerFactory<TDeps = unknown> = (deps: TDeps) => WorkerRuntime;

export interface WorkerDefinition<TDeps = unknown> {
  readonly kind: string;
  readonly note: string;
  readonly source?: 'built-in' | 'external';
  readonly factory: WorkerFactory<TDeps>;
}

export interface WorkerRegistry<TDeps = unknown> {
  register(definition: WorkerDefinition<TDeps>): void;
  get(kind: string): WorkerDefinition<TDeps> | undefined;
  list(): WorkerDefinition<TDeps>[];
}

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
