import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const MERGIFY_QUEUE_RESEARCH_WORKER_KIND = 'mergify-queue-research';
export const MERGIFY_QUEUE_RESEARCH_SCRIPT_RELATIVE_PATH = 'scripts/mergify-queue-research-watch.sh';
/** Default cadence: every 14 days. */
export const DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_DAYS = 14;
export const DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_MS = DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_DAYS * 86_400_000;

type EnvOverrides = Record<string, string | undefined>;

export interface MergifyQueueResearchWorkerConfig {
  /** Repository root that owns the shell script. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the shell entrypoint. `undefined` removes a variable. */
  env?: EnvOverrides;
  /**
   * Poll cadence in milliseconds. `> 0` arms the periodic timer.
   * Defaults to fourteen days.
   */
  intervalMs?: number;
  /** Shell executable used to run the existing entrypoint. Defaults to `bash`. */
  shell?: string;
  /**
   * When true or when maps are empty, the tick is a no-op (does not spawn).
   * Prefer omitting maps in config for empty; this flag is for tests.
   */
  skipWhenEmptyMaps?: boolean;
  /** Pre-parsed empty-maps signal from owner config. */
  hasMaps?: boolean;
}

export interface MergifyQueueResearchWorkerOptions extends MergifyQueueResearchWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
}

export interface MergifyQueueResearchTickOptions extends MergifyQueueResearchWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
}

/** Register the built-in mergify-queue-research research-swarm worker. */
export function registerMergifyQueueResearchWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
    note: 'Mines Mergify/admin-bypass ledger events and submits a discover→research→Linear workflow chain.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createMergifyQueueResearchWorker({
        logger: deps.logger,
        ...deps.mergifyQueueResearch,
      }),
  });
  return registry;
}

export function createMergifyQueueResearchWorker(options: MergifyQueueResearchWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createMergifyQueueResearchTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      skipWhenEmptyMaps: options.skipWhenEmptyMaps,
      hasMaps: options.hasMaps,
      spawnProcess: options.spawnProcess,
    }),
  });
}

export function createMergifyQueueResearchTick(options: MergifyQueueResearchTickOptions): WorkerTick {
  return async () => {
    if (options.hasMaps !== true || options.skipWhenEmptyMaps === true) {
      options.logger.info(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] empty maps; tick no-op`, {
        module: 'mergify-queue-research-worker',
        worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
      });
      return;
    }
    await runMergifyQueueResearchEntrypoint(options);
  };
}

async function runMergifyQueueResearchEntrypoint(options: MergifyQueueResearchTickOptions): Promise<void> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, MERGIFY_QUEUE_RESEARCH_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] spawning ${MERGIFY_QUEUE_RESEARCH_SCRIPT_RELATIVE_PATH}`, {
    module: 'mergify-queue-research-worker',
    worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
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
    options.logger.error(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] spawn failed`, {
      module: 'mergify-queue-research-worker',
      worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
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
        options.logger.error(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] process error`, {
          module: 'mergify-queue-research-worker',
          worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
          err,
        });
        rejectPromise(err);
      });
    });

    child.once('close', (code, signal) => {
      settle(() => {
        const fields = {
          module: 'mergify-queue-research-worker',
          worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
          code,
          signal,
        };
        if (code === 0) {
          options.logger.info(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] shell entrypoint completed`, fields);
          resolvePromise();
          return;
        }
        const message = `mergify-queue-research worker exited with code ${code ?? 'null'}`
          + (signal ? ` signal ${signal}` : '');
        options.logger.error(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] shell entrypoint failed`, fields);
        rejectPromise(new Error(message));
      });
    });
  });
}

function attachChildStreamLogger(
  options: MergifyQueueResearchTickOptions,
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
  options: MergifyQueueResearchTickOptions,
  streamName: 'stdout' | 'stderr',
  line: string,
): void {
  const fields = {
    module: 'mergify-queue-research-worker',
    worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
    stream: streamName,
  };
  if (streamName === 'stderr') {
    options.logger.warn(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] ${line}`, fields);
    return;
  }
  options.logger.info(`[worker:${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}] ${line}`, fields);
}
