import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@invoker/contracts';

import { cleanElectronEnv, getEffectivePath } from '../process-utils.js';
import { acquireWorkerLock, WorkerLockHeldError } from '../worker-lock.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

export const CODERABBIT_ADDRESS_WORKER_KIND = 'coderabbit-address';
export const PR_CONFLICT_REBASE_WORKER_KIND = 'pr-conflict-rebase';
export const MERGIFY_REQUEUE_WORKER_KIND = 'mergify-requeue';
export const DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS = 300_000;

const PR_MAINTENANCE_LOCK_KIND = 'pr-maintenance';

export interface PrScriptWorkerConfig {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
}

export interface MergifyRequeueWorkerConfig extends PrScriptWorkerConfig {
  pythonExecutable?: string;
  repo?: string;
  author?: string;
  stateFile?: string;
  extraArgs?: string[];
}

export interface PrMaintenanceWorkersConfig {
  coderabbitAddress?: PrScriptWorkerConfig;
  prConflictRebase?: PrScriptWorkerConfig;
  mergifyRequeue?: MergifyRequeueWorkerConfig;
}

export interface PrMaintenanceWorkerOptions<TConfig extends PrScriptWorkerConfig> {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  config?: TConfig;
}

interface PrMaintenanceCommand {
  command: string;
  args: string[];
}

export function registerPrMaintenanceWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_ADDRESS_WORKER_KIND,
    note: 'Runs the CodeRabbit review-addressing PR maintenance worker tick script.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createCoderabbitAddressWorker({
      logger: deps.logger,
      config: deps.prMaintenance?.coderabbitAddress,
    }),
  });
  registry.register({
    kind: PR_CONFLICT_REBASE_WORKER_KIND,
    note: 'Runs the PR conflict rebase/recreate maintenance worker tick script.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createPrConflictRebaseWorker({
      logger: deps.logger,
      config: deps.prMaintenance?.prConflictRebase,
    }),
  });
  registry.register({
    kind: MERGIFY_REQUEUE_WORKER_KIND,
    note: 'Repairs and requeues admin-bypass PRs after Mergify dequeue events.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createMergifyRequeueWorker({
      logger: deps.logger,
      config: deps.prMaintenance?.mergifyRequeue,
    }),
  });
  return registry;
}

export function createCoderabbitAddressWorker(
  options: PrMaintenanceWorkerOptions<PrScriptWorkerConfig>,
): WorkerRuntime {
  return createPrMaintenanceWorker(CODERABBIT_ADDRESS_WORKER_KIND, options, (repoRoot) => ({
    command: 'bash',
    args: [join(repoRoot, 'scripts', 'cron-coderabbit-address.sh')],
  }));
}

export function createPrConflictRebaseWorker(
  options: PrMaintenanceWorkerOptions<PrScriptWorkerConfig>,
): WorkerRuntime {
  return createPrMaintenanceWorker(PR_CONFLICT_REBASE_WORKER_KIND, options, (repoRoot) => ({
    command: 'bash',
    args: [join(repoRoot, 'scripts', 'cron-pr-conflict-rebase.sh')],
  }));
}

export function createMergifyRequeueWorker(
  options: PrMaintenanceWorkerOptions<MergifyRequeueWorkerConfig>,
): WorkerRuntime {
  return createPrMaintenanceWorker(MERGIFY_REQUEUE_WORKER_KIND, options, (repoRoot, config) => {
    const pythonExecutable = config.pythonExecutable ?? process.env.INVOKER_MERGIFY_REQUEUE_PYTHON ?? 'python3';
    const repo = config.repo ?? process.env.INVOKER_MERGIFY_REQUEUE_REPO ?? 'Neko-Catpital-Labs/Invoker';
    const author = config.author ?? process.env.INVOKER_MERGIFY_REQUEUE_AUTHOR ?? 'EdbertChan';
    const stateFile = config.stateFile
      ?? process.env.INVOKER_MERGIFY_REQUEUE_STATE_FILE
      ?? join(homedir(), '.invoker', 'mergify-admin-requeue-state.jsonl');
    return {
      command: pythonExecutable,
      args: [
        join(repoRoot, 'scripts', 'mergify_admin_requeue.py'),
        '--once',
        '--repo', repo,
        '--author', author,
        '--state-file', stateFile,
        ...(config.extraArgs ?? []),
      ],
    };
  });
}

function createPrMaintenanceWorker<TConfig extends PrScriptWorkerConfig>(
  kind: string,
  options: PrMaintenanceWorkerOptions<TConfig>,
  buildCommand: (repoRoot: string, config: TConfig) => PrMaintenanceCommand,
): WorkerRuntime {
  const config = options.config ?? ({} as TConfig);
  return createWorkerRuntime({
    kind,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: config.intervalMs ?? DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: createPrMaintenanceTick(kind, options.logger, config, buildCommand),
  });
}

function createPrMaintenanceTick<TConfig extends PrScriptWorkerConfig>(
  kind: string,
  logger: Logger,
  config: TConfig,
  buildCommand: (repoRoot: string, config: TConfig) => PrMaintenanceCommand,
): WorkerTick {
  return async () => {
    let lock;
    try {
      lock = acquireWorkerLock({ kind: PR_MAINTENANCE_LOCK_KIND, logger });
    } catch (err) {
      if (err instanceof WorkerLockHeldError) {
        logger.info(`[worker:${kind}] another PR maintenance worker is running; skipping tick`, {
          module: 'pr-maintenance-workers',
          kind,
        });
        return;
      }
      throw err;
    }

    try {
      const repoRoot = config.repoRoot ?? process.env.INVOKER_PR_MAINTENANCE_REPO_ROOT ?? process.cwd();
      const command = buildCommand(repoRoot, config);
      await runPrMaintenanceCommand(kind, logger, repoRoot, config, command);
    } finally {
      lock.release();
    }
  };
}

async function runPrMaintenanceCommand(
  kind: string,
  logger: Logger,
  repoRoot: string,
  config: PrScriptWorkerConfig,
  prCommand: PrMaintenanceCommand,
): Promise<void> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let settled = false;

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };

  let child;
  try {
    child = spawn(prCommand.command, prCommand.args, {
      cwd: repoRoot,
      env: {
        ...cleanElectronEnv(),
        ...(config.env ?? {}),
        PATH: getEffectivePath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    logger.error(`[worker:${kind}] tick failed`, {
      module: 'pr-maintenance-workers',
      kind,
      stderr,
      err,
    });
    throw new Error(`${kind} worker tick failed to spawn`);
  }

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutChunks.push(buffer);
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrChunks.push(buffer);
    process.stderr.write(chunk);
  });
  child.once('error', (err: Error) => settle(() => {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    logger.error(`[worker:${kind}] tick failed`, {
      module: 'pr-maintenance-workers',
      kind,
      stderr,
      err,
    });
    reject(new Error(`${kind} worker tick failed to spawn`));
  }));
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => settle(() => {
    if (code === 0) {
      logger.info(`[worker:${kind}] tick completed`, {
        module: 'pr-maintenance-workers',
        kind,
      });
      resolve();
      return;
    }
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    logger.error(`[worker:${kind}] tick failed`, {
      module: 'pr-maintenance-workers',
      kind,
      exitCode: code,
      signal,
      stderr,
    });
    reject(new Error(`${kind} worker tick failed with exit code ${code}`));
  }));

  await promise;
}
