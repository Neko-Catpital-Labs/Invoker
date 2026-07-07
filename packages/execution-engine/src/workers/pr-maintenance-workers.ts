import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CODERABBIT_ADDRESS_WORKER_KIND = 'coderabbit-address';
export const PR_CONFLICT_REBASE_WORKER_KIND = 'pr-conflict-rebase';
export const DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS = 5 * 60_000;

const CODERABBIT_ADDRESS_SCRIPT = 'scripts/cron-coderabbit-address.sh';
const PR_CONFLICT_REBASE_SCRIPT = 'scripts/cron-pr-conflict-rebase.sh';
const DEFAULT_SHELL = 'bash';

export interface PrMaintenanceWorkerRuntimeConfig {
  /** Repository checkout containing the existing PR-maintenance shell scripts. */
  repoRoot?: string;
  /** Environment overrides passed to the shell cron entrypoint. */
  env?: NodeJS.ProcessEnv;
  /** Shell executable used to invoke the cron script. */
  shell?: string;
}

export interface PrMaintenanceWorkerPolicyOptions extends PrMaintenanceWorkerRuntimeConfig {
  kind: string;
  scriptPath: string;
  logger: Logger;
  runScript?: PrMaintenanceScriptRunner;
}

export interface PrMaintenanceWorkerOptions extends PrMaintenanceWorkerPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrMaintenanceScriptRunOptions {
  kind: string;
  repoRoot: string;
  scriptPath: string;
  shell: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export type PrMaintenanceScriptRunner = (options: PrMaintenanceScriptRunOptions) => Promise<void>;

/** Register both built-in PR-maintenance shell wrapper workers. */
export function registerPrMaintenanceWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_ADDRESS_WORKER_KIND,
    note: 'Runs the existing CodeRabbit PR-addressing shell cron entrypoint on the worker schedule.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createCoderabbitAddressWorker({
      logger: deps.logger,
      ...(deps.prMaintenance ?? {}),
    }),
  });
  registry.register({
    kind: PR_CONFLICT_REBASE_WORKER_KIND,
    note: 'Runs the existing PR conflict rebase shell cron entrypoint on the worker schedule.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createPrConflictRebaseWorker({
      logger: deps.logger,
      ...(deps.prMaintenance ?? {}),
    }),
  });
  return registry;
}

export function createCoderabbitAddressWorker(
  options: Omit<PrMaintenanceWorkerOptions, 'kind' | 'scriptPath'>,
): WorkerRuntime {
  return createPrMaintenanceWorker({
    ...options,
    kind: CODERABBIT_ADDRESS_WORKER_KIND,
    scriptPath: CODERABBIT_ADDRESS_SCRIPT,
  });
}

export function createPrConflictRebaseWorker(
  options: Omit<PrMaintenanceWorkerOptions, 'kind' | 'scriptPath'>,
): WorkerRuntime {
  return createPrMaintenanceWorker({
    ...options,
    kind: PR_CONFLICT_REBASE_WORKER_KIND,
    scriptPath: PR_CONFLICT_REBASE_SCRIPT,
  });
}

export function createPrMaintenanceTick(options: PrMaintenanceWorkerPolicyOptions): WorkerTick {
  const runScript = options.runScript ?? runPrMaintenanceScript;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const shell = options.shell ?? DEFAULT_SHELL;
  return async () => {
    await runScript({
      kind: options.kind,
      repoRoot,
      scriptPath: options.scriptPath,
      shell,
      env: options.env,
      logger: options.logger,
    });
  };
}

export function createPrMaintenanceWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: options.kind,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrMaintenanceTick(options),
  });
}

export async function runPrMaintenanceScript(options: PrMaintenanceScriptRunOptions): Promise<void> {
  const script = join(options.repoRoot, options.scriptPath);
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: options.repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  options.logger.info(`[worker:${options.kind}] launching PR maintenance script`, {
    module: 'pr-maintenance-worker',
    kind: options.kind,
    script,
  });

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(options.shell, [script], spawnOptions);
    const logFields = { module: 'pr-maintenance-worker', kind: options.kind, script };

    let stdoutRemainder = '';
    let stderrRemainder = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdoutRemainder = logLines(options.logger, 'info', options.kind, 'stdout', stdoutRemainder + chunk, logFields);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrRemainder = logLines(options.logger, 'warn', options.kind, 'stderr', stderrRemainder + chunk, logFields);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (stdoutRemainder.length > 0) {
        options.logger.info(`[worker:${options.kind}] stdout ${stdoutRemainder}`, { ...logFields, stream: 'stdout' });
      }
      if (stderrRemainder.length > 0) {
        options.logger.warn(`[worker:${options.kind}] stderr ${stderrRemainder}`, { ...logFields, stream: 'stderr' });
      }
      if (code === 0) {
        options.logger.info(`[worker:${options.kind}] PR maintenance script completed`, { ...logFields, code });
        resolvePromise();
        return;
      }
      reject(new Error(`PR maintenance script ${script} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`));
    });
  });
}

function logLines(
  logger: Logger,
  level: 'info' | 'warn',
  kind: string,
  stream: 'stdout' | 'stderr',
  text: string,
  fields: Record<string, unknown>,
): string {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    if (line.length > 0) {
      logger[level](`[worker:${kind}] ${stream} ${line}`, { ...fields, stream });
    }
  }
  return remainder;
}
