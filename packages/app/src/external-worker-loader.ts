import {
  registerExternalWorkers,
  type WorkerRegistry,
} from '@invoker/execution-engine';

import type { ExternalWorkerConfig } from './config.js';

export function registerExternalWorkersFromConfig<TDeps>(
  externalWorkers: readonly ExternalWorkerConfig[] | undefined,
  registry: WorkerRegistry<TDeps>,
): WorkerRegistry<TDeps> {
  return registerExternalWorkers(registry, externalWorkers);
}
