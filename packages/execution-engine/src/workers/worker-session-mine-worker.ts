import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const WORKER_SESSION_MINE_WORKER_KIND = 'worker-session-mine';
export const WORKER_SESSION_MINE_SCRIPT_RELATIVE_PATH = 'scripts/cron-worker-session-mine.sh';
/** Default cadence: hourly thrash scan of terminal worker Claude sessions. */
export const DEFAULT_WORKER_SESSION_MINE_INTERVAL_MS = 60 * 60_000;

type EnvOverrides = Record<string, string | undefined>;

export interface WorkerSessionMineWorkerConfig {
  repoRoot?: string;
  env?: EnvOverrides;
  intervalMs?: number;
  shell?: string;
}

export interface WorkerSessionMineWorkerOptions extends WorkerSessionMineWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
}

export interface WorkerSessionMineTickOptions extends WorkerSessionMineWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
}

/** Register the off-by-default worker session thrash miner. */
export function registerWorkerSessionMineWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: WORKER_SESSION_MINE_WORKER_KIND,
    note: 'Scans terminal Invoker Claude sessions for thrash and files follow-up reflect/fix workflows (off by default).',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createWorkerSessionMineWorker({
        logger: deps.logger,
        ...deps.workerSessionMine,
      }),
  });
  return registry;
}

export function createWorkerSessionMineWorker(options: WorkerSessionMineWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: WORKER_SESSION_MINE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_WORKER_SESSION_MINE_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createWorkerSessionMineTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      spawnProcess: options.spawnProcess,
    }),
  });
}

export function createWorkerSessionMineTick(options: WorkerSessionMineTickOptions): WorkerTick {
  return async () => {
    await runWorkerSessionMineEntrypoint(options);
  };
}

async function runWorkerSessionMineEntrypoint(options: WorkerSessionMineTickOptions): Promise<void> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, WORKER_SESSION_MINE_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${WORKER_SESSION_MINE_WORKER_KIND}] spawning ${WORKER_SESSION_MINE_SCRIPT_RELATIVE_PATH}`, {
    module: 'worker-session-mine-worker',
    worker: WORKER_SESSION_MINE_WORKER_KIND,
    cwd: repoRoot,
  });

  let child: ChildProcess;
  try {
    const childEnv = { ...process.env, ...options.env };
    delete childEnv.INVOKER_HEADLESS_STANDALONE;
    child = spawnProcess(shell, [scriptPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    options.logger.error(`[worker:${WORKER_SESSION_MINE_WORKER_KIND}] spawn failed`, {
      module: 'worker-session-mine-worker',
      worker: WORKER_SESSION_MINE_WORKER_KIND,
      err,
    });
    throw err;
  }

  attachChildStreamLogger(options, child.stdout, 'stdout');
  attachChildStreamLogger(options, child.stderr, 'stderr');

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.once('error', (err) => {
      settle(() => rejectPromise(err));
    });

    child.once('close', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(
          `worker-session-mine exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`,
        ));
      });
    });
  });
}

function attachChildStreamLogger(
  options: WorkerSessionMineTickOptions,
  stream: Readable | null,
  streamName: 'stdout' | 'stderr',
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const fields = {
        module: 'worker-session-mine-worker',
        worker: WORKER_SESSION_MINE_WORKER_KIND,
        stream: streamName,
      };
      if (streamName === 'stderr') options.logger.warn(`[worker:${WORKER_SESSION_MINE_WORKER_KIND}] ${line}`, fields);
      else options.logger.info(`[worker:${WORKER_SESSION_MINE_WORKER_KIND}] ${line}`, fields);
    }
  });
}
