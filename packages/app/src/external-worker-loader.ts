import {
  registerExternalWorkers,
  type WorkerRegistry,
} from '@invoker/execution-engine';

import type { ExternalWorkerConfig } from './config.js';

export function registerExternalWorkersFromConfig(
  externalWorkers: readonly ExternalWorkerConfig[] | undefined,
  registry: WorkerRegistry,
): WorkerRegistry {
  return registerExternalWorkers(registry, externalWorkers);
}
