import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const SESSION_TOKEN_PUSH_WORKER_KIND = 'session-token-push';
export const SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH = 'scripts/cron-session-token-push.sh';
export const DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS = 7 * 24 * 60 * 60_000;

type EnvOverrides = Record<string, string | undefined>;

export interface SessionTokenPushWorkerConfig {
  repoRoot?: string;
  env?: EnvOverrides;
  intervalMs?: number;
  shell?: string;
}

export interface SessionTokenPushWorkerOptions extends SessionTokenPushWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
}

export interface SessionTokenPushTickOptions extends SessionTokenPushWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
}

export function registerSessionTokenPushWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: SESSION_TOKEN_PUSH_WORKER_KIND,
    note: 'Collects this machine\'s Claude session token rollup weekly and copies it to the configured remote target (off by default).',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createSessionTokenPushWorker({
        logger: deps.logger,
        ...deps.sessionTokenPush,
      }),
  });
  return registry;
}

export function createSessionTokenPushWorker(options: SessionTokenPushWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: SESSION_TOKEN_PUSH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createSessionTokenPushTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      spawnProcess: options.spawnProcess,
    }),
  });
}

export function createSessionTokenPushTick(options: SessionTokenPushTickOptions): WorkerTick {
  return async () => {
    await runSessionTokenPushEntrypoint(options);
  };
}

async function runSessionTokenPushEntrypoint(options: SessionTokenPushTickOptions): Promise<void> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${SESSION_TOKEN_PUSH_WORKER_KIND}] spawning ${SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH}`, {
    module: 'session-token-push-worker',
    worker: SESSION_TOKEN_PUSH_WORKER_KIND,
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
    options.logger.error(`[worker:${SESSION_TOKEN_PUSH_WORKER_KIND}] spawn failed`, {
      module: 'session-token-push-worker',
      worker: SESSION_TOKEN_PUSH_WORKER_KIND,
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
          `session-token-push exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`,
        ));
      });
    });
  });
}

function attachChildStreamLogger(
  options: SessionTokenPushTickOptions,
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
        module: 'session-token-push-worker',
        worker: SESSION_TOKEN_PUSH_WORKER_KIND,
        stream: streamName,
      };
      if (streamName === 'stderr') options.logger.warn(`[worker:${SESSION_TOKEN_PUSH_WORKER_KIND}] ${line}`, fields);
      else options.logger.info(`[worker:${SESSION_TOKEN_PUSH_WORKER_KIND}] ${line}`, fields);
    }
  });
}
