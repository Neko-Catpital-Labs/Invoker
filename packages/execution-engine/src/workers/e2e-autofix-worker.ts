import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const E2E_AUTOFIX_WORKER_KIND = 'e2e-autofix';
export const E2E_AUTOFIX_SCRIPT_RELATIVE_PATH = 'scripts/cron-e2e-regression-watch.sh';
/** Default cadence: sweep default-branch push CI every fifteen minutes. */
export const DEFAULT_E2E_AUTOFIX_INTERVAL_MS = 15 * 60_000;
/**
 * If the spawned child's own process exits but Node's `close` event does not
 * follow within this window, resolve the tick using the `exit` result anyway
 * instead of waiting on `close` forever. `close` only fires once every stdio
 * pipe (not just the direct child's) has ended; a grandchild that inherits
 * the piped stdout/stderr fds and outlives its parent (e.g. `something &`
 * inside the shell entrypoint) can hold that pipe open indefinitely even
 * though the direct child has fully exited, permanently blocking every
 * future tick — worker-runtime.ts's scheduler coalesces ticks, so a tick
 * that never settles blocks the worker forever, silently (2026-08-31: e2e-
 * autofix ticked once after an owner restart, then never again for 40+
 * minutes, with no error logged — proven root cause via a controlled repro:
 * `exit` fires immediately while `close` never fires when the child
 * backgrounds a long-lived grandchild sharing its stdio fds).
 */
export const DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS = 2_000;

type EnvOverrides = Record<string, string | undefined>;

export interface E2eAutoFixWorkerConfig {
  /** Repository root that owns the shell script. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the shell entrypoint. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence in milliseconds. `> 0` arms the periodic timer. Defaults to fifteen minutes. */
  intervalMs?: number;
  /** Shell executable used to run the existing entrypoint. Defaults to `bash`. */
  shell?: string;
  /** See DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
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

/** Register the built-in default-branch CI auto-fix watcher. */
export function registerE2eAutoFixWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: E2E_AUTOFIX_WORKER_KIND,
    note: 'Watches default-branch push CI and opens one repair workflow per first-bad SHA/job.',
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
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createE2eAutoFixTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      closeGraceMs: options.closeGraceMs,
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
    const childEnv = { ...process.env, ...options.env };
    delete childEnv.INVOKER_HEADLESS_STANDALONE;
    child = spawnProcess(shell, [scriptPath], {
      cwd: repoRoot,
      env: childEnv,
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

  const closeGraceMs = options.closeGraceMs ?? DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      fn();
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, source: 'close' | 'exit'): void => {
      settle(() => {
        const fields = {
          module: 'e2e-autofix-worker',
          worker: E2E_AUTOFIX_WORKER_KIND,
          code,
          signal,
          source,
        };
        if (code === 0) {
          if (source === 'exit') {
            options.logger.warn(
              `[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint exited but stdio did not close within ${closeGraceMs}ms; resolving via exit so future ticks are not blocked`,
              fields,
            );
          } else {
            options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint completed`, fields);
          }
          resolvePromise();
          return;
        }
        const message = `e2e auto-fix worker exited with code ${code ?? 'null'}`
          + (signal ? ` signal ${signal}` : '');
        options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint failed`, fields);
        rejectPromise(new Error(message));
      });
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

    child.once('close', (code, signal) => finish(code, signal, 'close'));

    child.once('exit', (code, signal) => {
      if (settled) return;
      graceTimer = setTimeout(() => finish(code, signal, 'exit'), closeGraceMs);
      graceTimer.unref?.();
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
