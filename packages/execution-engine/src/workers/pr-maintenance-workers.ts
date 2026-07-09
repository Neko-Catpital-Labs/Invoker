import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  createDefaultPrMaintenanceDeps,
  resolvePrMaintenanceRuntime,
  runCoderabbitAddressTick,
  runPrConflictRebaseTick,
  type PrMaintenanceBackendDeps,
  type PrMaintenanceWorkerConfig,
  type PrMaintenanceWorkerKind,
} from './pr-maintenance-backend.js';
import { openPrMaintenanceLedger, type PrMaintenanceLedger } from './pr-maintenance-ledger.js';
import {
  acquirePrMaintenanceLock,
  type PrMaintenanceLockAcquirer,
} from './pr-maintenance-lock.js';

export {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  type PrMaintenanceWorkerConfig,
  type PrMaintenanceWorkerKind,
  type PrMaintenanceBackendDeps,
} from './pr-maintenance-backend.js';
export {
  acquirePrMaintenanceLock,
  type PrMaintenanceLockAcquirer,
  type PrMaintenanceLockResult,
} from './pr-maintenance-lock.js';
export { openPrMaintenanceLedger, type PrMaintenanceLedger } from './pr-maintenance-ledger.js';

export const DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS = 5 * 60_000;

export interface PrMaintenanceWorkerOptions extends PrMaintenanceWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  /** Backend seams; production defaults are used for anything omitted. */
  deps?: Partial<PrMaintenanceBackendDeps>;
  /** Shared-lock acquirer seam. Defaults to the native mkdir lock. */
  lock?: PrMaintenanceLockAcquirer;
  /** Attempt ledger seam. Defaults to the durable per-job TSV ledger. */
  ledger?: PrMaintenanceLedger;
}

export interface PrMaintenanceTickOptions extends PrMaintenanceWorkerConfig {
  kind: PrMaintenanceWorkerKind;
  logger: Logger;
  deps?: Partial<PrMaintenanceBackendDeps>;
  lock?: PrMaintenanceLockAcquirer;
  ledger?: PrMaintenanceLedger;
}

/** Register both built-in PR-maintenance workers in cron job order. */
export function registerPrMaintenanceWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerCoderabbitAddressWorker(registry);
  registerPrConflictRebaseWorker(registry);
  return registry;
}

export function registerCoderabbitAddressWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_ADDRESS_WORKER_KIND,
    note: 'Runs the CodeRabbit review-address cron entrypoint under worker scheduling.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCoderabbitAddressWorker({
        logger: deps.logger,
        ...deps.prMaintenance,
      }),
  });
  return registry;
}

export function registerPrConflictRebaseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_CONFLICT_REBASE_WORKER_KIND,
    note: 'Runs the PR conflict rebase-recreate cron entrypoint under worker scheduling.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrConflictRebaseWorker({
        logger: deps.logger,
        ...deps.prMaintenance,
      }),
  });
  return registry;
}

export function createCoderabbitAddressWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(CODERABBIT_ADDRESS_WORKER_KIND, options);
}

export function createPrConflictRebaseWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(PR_CONFLICT_REBASE_WORKER_KIND, options);
}

export function createPrMaintenanceTick(options: PrMaintenanceTickOptions): WorkerTick {
  return async () => {
    await runPrMaintenanceTick(options);
  };
}

function createPrMaintenanceWorker(
  kind: PrMaintenanceWorkerKind,
  options: PrMaintenanceWorkerOptions,
): WorkerRuntime {
  return createWorkerRuntime({
    kind,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrMaintenanceTick({
      kind,
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      lockPath: options.lockPath,
      shell: options.shell,
      deps: options.deps,
      lock: options.lock,
      ledger: options.ledger,
    }),
  });
}

async function runPrMaintenanceTick(options: PrMaintenanceTickOptions): Promise<void> {
  const config = resolvePrMaintenanceRuntime(options);
  const { logger, kind } = options;
  const fields = { module: 'pr-maintenance-worker', worker: kind };

  const acquire = options.lock ?? acquirePrMaintenanceLock;
  const lock = await acquire({ lockPath: config.lockPath, staleLockSeconds: config.staleLockSeconds });
  if (!lock.acquired) {
    logger.info(`[worker:${kind}] shared PR maintenance lock held; skipping tick`, {
      ...fields,
      lockPath: config.lockPath,
      reason: lock.reason,
    });
    return;
  }

  try {
    const deps: PrMaintenanceBackendDeps = {
      ...createDefaultPrMaintenanceDeps(config, logger),
      ...options.deps,
    };
    const ledgerPath = kind === CODERABBIT_ADDRESS_WORKER_KIND
      ? config.coderabbitStateFile
      : config.conflictStateFile;
    const ledger = options.ledger ?? openPrMaintenanceLedger(ledgerPath);
    const runArgs = { config, deps, ledger, logger };

    if (kind === CODERABBIT_ADDRESS_WORKER_KIND) {
      await runCoderabbitAddressTick(runArgs);
    } else {
      await runPrConflictRebaseTick(runArgs);
    }
  } finally {
    lock.release();
  }
}
