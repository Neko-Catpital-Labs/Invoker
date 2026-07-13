import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const E2E_AUTOFIX_WORKER_KIND = 'e2e-autofix';
export const E2E_AUTOFIX_SCRIPT_RELATIVE_PATH = 'scripts/daily-e2e-do-submit.sh';
/** Default cadence: run the battery about twice a day (every twelve hours). */
export const DEFAULT_E2E_AUTOFIX_INTERVAL_MS = 12 * 60 * 60_000;

type EnvOverrides = Record<string, string | undefined>;

export interface E2eAutoFixWorkerConfig {
  /** Repository root that owns the shell script. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the shell entrypoint. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence in milliseconds. `> 0` arms the periodic timer. Defaults to twelve hours. */
  intervalMs?: number;
  /** Shell executable used to run the existing entrypoint. Defaults to `bash`. */
  shell?: string;
}

export interface E2eAutoFixWorkerOptions extends E2eAutoFixWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
}

export interface E2eAutoFixTickOptions extends E2eAutoFixWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
}

/** Register the built-in e2e auto-fix battery worker. */
export function registerE2eAutoFixWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: E2E_AUTOFIX_WORKER_KIND,
    note: 'Periodically runs the extended e2e battery and opens one auto-fix PR per failing suite.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createE2eAutoFixWorker({
        logger: deps.logger,
        ...deps.e2eAutoFix,
      }),
  });
  return registry;
}

export function createE2eAutoFixWorker(options: E2eAutoFixWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: E2E_AUTOFIX_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_E2E_AUTOFIX_INTERVAL_MS,
    // Auto-start on launch must NOT immediately kick off a ~1h battery.
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createE2eAutoFixTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      spawnProcess: options.spawnProcess,
    }),
  });
}

export function createE2eAutoFixTick(options: E2eAutoFixTickOptions): WorkerTick {
  return async () => {
    await runE2eAutoFixEntrypoint(options);
  };
}

async function runE2eAutoFixEntrypoint(options: E2eAutoFixTickOptions): Promise<void> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, E2E_AUTOFIX_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] spawning ${E2E_AUTOFIX_SCRIPT_RELATIVE_PATH}`, {
    module: 'e2e-autofix-worker',
    worker: E2E_AUTOFIX_WORKER_KIND,
    cwd: repoRoot,
    command: shell,
    args: [scriptPath],
  });

  let child: ChildProcess;
  try {
    child = spawnProcess(shell, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] spawn failed`, {
      module: 'e2e-autofix-worker',
      worker: E2E_AUTOFIX_WORKER_KIND,
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
      settle(() => {
        options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] process error`, {
          module: 'e2e-autofix-worker',
          worker: E2E_AUTOFIX_WORKER_KIND,
          err,
        });
        rejectPromise(err);
      });
    });

    child.once('close', (code, signal) => {
      settle(() => {
        const fields = {
          module: 'e2e-autofix-worker',
          worker: E2E_AUTOFIX_WORKER_KIND,
          code,
          signal,
        };
        if (code === 0) {
          options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint completed`, fields);
          resolvePromise();
          return;
        }
        const message = `e2e auto-fix worker exited with code ${code ?? 'null'}`
          + (signal ? ` signal ${signal}` : '');
        options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint failed`, fields);
        rejectPromise(new Error(message));
      });
    });
  });
}

function attachChildStreamLogger(
  options: E2eAutoFixTickOptions,
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
      logChildLine(options, streamName, line);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      logChildLine(options, streamName, buffer);
      buffer = '';
    }
  });
}

function logChildLine(
  options: E2eAutoFixTickOptions,
  streamName: 'stdout' | 'stderr',
  line: string,
): void {
  const fields = {
    module: 'e2e-autofix-worker',
    worker: E2E_AUTOFIX_WORKER_KIND,
    stream: streamName,
  };
  if (streamName === 'stderr') {
    options.logger.warn(`[worker:${E2E_AUTOFIX_WORKER_KIND}] ${line}`, fields);
    return;
  }
  options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] ${line}`, fields);
}
