import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const INFRA_REPAIR_WORKER_KIND = 'infra-repair';
export const DEFAULT_INFRA_REPAIR_WORKER_INTERVAL_MS = 60_000;

export interface InfraRepairRemoteTargetConfig {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  provisionCommand?: string;
  remoteInvokerHome?: string;
}

export interface InfraRepairWorkerConfig {
  ownerRepoRoot: string;
  ownerInvokerHome: string;
  remoteTargets: Record<string, InfraRepairRemoteTargetConfig>;
  repairCooldownMs?: number;
}

export interface InfraRepairWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function createInfraRepairWorker(options: InfraRepairWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: INFRA_REPAIR_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_INFRA_REPAIR_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    onTick: options.onTick ?? (async () => {}),
  });
}

export function registerInfraRepairWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: INFRA_REPAIR_WORKER_KIND,
    note: 'Repairs infra-owned SSH and review-gate CI failures before retrying them.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createInfraRepairWorker({
      logger: deps.logger,
    }),
  });
  return registry;
}
