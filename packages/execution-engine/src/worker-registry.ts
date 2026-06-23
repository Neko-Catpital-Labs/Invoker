import type { Logger } from '@invoker/contracts';

import { createAutoFixRecoveryWorker } from './auto-fix-recovery.js';
import type { WorkerRuntime } from './worker-runtime.js';

export const AUTO_FIX_WORKER_KIND = 'autofix';

export interface WorkerStateAccessor {
  loadTask(taskId: string): unknown;
}

export interface WorkerOutputChannel {
  append(taskId: string, data: string): void;
}

export interface AutoFixWorkerRuntimeConfig {
  defaultAttemptBudget: number;
  chosenAgent: string;
  intervalMs?: number;
  instanceId?: string;
  tickOnStart?: boolean;
  installSignalHandlers?: boolean;
}

export interface WorkerFactoryDependencies {
  state: WorkerStateAccessor;
  actionOutput: WorkerOutputChannel;
  logger: Logger;
  autoFix: AutoFixWorkerRuntimeConfig;
}

export interface WorkerDefinition {
  kind: string;
  operatorNote: string;
  createRuntime(deps: WorkerFactoryDependencies): WorkerRuntime;
}

export class WorkerRegistry {
  private definitions = new Map<string, WorkerDefinition>();

  register(definition: WorkerDefinition): void {
    this.definitions.set(definition.kind, definition);
  }

  getByKind(kind: string): WorkerDefinition | undefined {
    return this.definitions.get(kind);
  }

  getAll(): WorkerDefinition[] {
    return [...this.definitions.values()];
  }
}

export function createAutoFixWorkerDefinition(): WorkerDefinition {
  return {
    kind: AUTO_FIX_WORKER_KIND,
    operatorNote: 'Shared recovery worker for task autofix.',
    createRuntime: (deps: WorkerFactoryDependencies): WorkerRuntime => createAutoFixRecoveryWorker({
      logger: deps.logger,
      instanceId: deps.autoFix.instanceId,
      intervalMs: deps.autoFix.intervalMs,
      installSignalHandlers: deps.autoFix.installSignalHandlers,
      tickOnStart: deps.autoFix.tickOnStart,
    }),
  };
}

export function registerBuiltinAutoFixWorker(registry: WorkerRegistry): WorkerRegistry {
  registry.register(createAutoFixWorkerDefinition());
  return registry;
}

export function createWorkerRegistry(): WorkerRegistry {
  return registerBuiltinAutoFixWorker(new WorkerRegistry());
}
