import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CROSS_REPO_RESEARCH_WORKER_KIND = 'cross-repo-research';
export const CROSS_REPO_RESEARCH_SCRIPT_RELATIVE_PATH = 'scripts/cross-repo-research-watch.sh';
/** Default cadence: every 14 days. */
export const DEFAULT_CROSS_REPO_RESEARCH_INTERVAL_DAYS = 14;
export const DEFAULT_CROSS_REPO_RESEARCH_INTERVAL_MS = DEFAULT_CROSS_REPO_RESEARCH_INTERVAL_DAYS * 86_400_000;

type EnvOverrides = Record<string, string | undefined>;

export interface CrossRepoResearchWorkerConfig {
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

export interface CrossRepoResearchWorkerOptions extends CrossRepoResearchWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
}

export interface CrossRepoResearchTickOptions extends CrossRepoResearchWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
}

/** Register the built-in cross-repo-research research-swarm worker. */
export function registerCrossRepoResearchWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CROSS_REPO_RESEARCH_WORKER_KIND,
    note: 'Mines mapped source repos and submits a discover→research→Linear workflow chain.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCrossRepoResearchWorker({
        logger: deps.logger,
        ...deps.crossRepoResearch,
      }),
  });
  return registry;
}

export function createCrossRepoResearchWorker(options: CrossRepoResearchWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: CROSS_REPO_RESEARCH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_CROSS_REPO_RESEARCH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createCrossRepoResearchTick({
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

export function createCrossRepoResearchTick(options: CrossRepoResearchTickOptions): WorkerTick {
  return async () => {
    if (options.hasMaps !== true || options.skipWhenEmptyMaps === true) {
      options.logger.info(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] empty maps; tick no-op`, {
        module: 'cross-repo-research-worker',
        worker: CROSS_REPO_RESEARCH_WORKER_KIND,
      });
      return;
    }
    await runCrossRepoResearchEntrypoint(options);
  };
}

async function runCrossRepoResearchEntrypoint(options: CrossRepoResearchTickOptions): Promise<void> {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, CROSS_REPO_RESEARCH_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] spawning ${CROSS_REPO_RESEARCH_SCRIPT_RELATIVE_PATH}`, {
    module: 'cross-repo-research-worker',
    worker: CROSS_REPO_RESEARCH_WORKER_KIND,
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
    options.logger.error(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] spawn failed`, {
      module: 'cross-repo-research-worker',
      worker: CROSS_REPO_RESEARCH_WORKER_KIND,
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
        options.logger.error(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] process error`, {
          module: 'cross-repo-research-worker',
          worker: CROSS_REPO_RESEARCH_WORKER_KIND,
          err,
        });
        rejectPromise(err);
      });
    });

    child.once('close', (code, signal) => {
      settle(() => {
        const fields = {
          module: 'cross-repo-research-worker',
          worker: CROSS_REPO_RESEARCH_WORKER_KIND,
          code,
          signal,
        };
        if (code === 0) {
          options.logger.info(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] shell entrypoint completed`, fields);
          resolvePromise();
          return;
        }
        const message = `cross-repo-research worker exited with code ${code ?? 'null'}`
          + (signal ? ` signal ${signal}` : '');
        options.logger.error(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] shell entrypoint failed`, fields);
        rejectPromise(new Error(message));
      });
    });
  });
}

function attachChildStreamLogger(
  options: CrossRepoResearchTickOptions,
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
  options: CrossRepoResearchTickOptions,
  streamName: 'stdout' | 'stderr',
  line: string,
): void {
  const fields = {
    module: 'cross-repo-research-worker',
    worker: CROSS_REPO_RESEARCH_WORKER_KIND,
    stream: streamName,
  };
  if (streamName === 'stderr') {
    options.logger.warn(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] ${line}`, fields);
    return;
  }
  options.logger.info(`[worker:${CROSS_REPO_RESEARCH_WORKER_KIND}] ${line}`, fields);
}
