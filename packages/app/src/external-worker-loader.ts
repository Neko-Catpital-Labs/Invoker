import { spawn, type ChildProcess } from 'node:child_process';

import type {
  WorkerDefinition,
  WorkerRegistry,
  WorkerRuntime,
  WorkerRuntimeDependencies,
  WorkerTickReason,
} from '@invoker/execution-engine';

import type { ExternalWorkerConfig } from './config.js';

const EXTERNAL_WORKER_RUNTIME = Symbol('externalWorkerRuntime');
const EXTERNAL_WORKER_SHUTDOWN_GRACE_MS = 5_000;

let externalWorkerInstanceCounter = 0;

const EXTERNAL_WORKER_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
] as const;

function createExternalWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of EXTERNAL_WORKER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface ExternalWorkerRuntime extends WorkerRuntime {
  readonly [EXTERNAL_WORKER_RUNTIME]: true;
  waitForExit(): Promise<void>;
}

export function isExternalWorkerRuntime(runtime: WorkerRuntime): runtime is ExternalWorkerRuntime {
  return (runtime as Partial<ExternalWorkerRuntime>)[EXTERNAL_WORKER_RUNTIME] === true;
}

export function registerExternalWorkers(
  registry: WorkerRegistry,
  externalWorkers: readonly ExternalWorkerConfig[] | undefined,
): WorkerRegistry {
  if (!externalWorkers || externalWorkers.length === 0) return registry;

  for (const worker of externalWorkers) {
    if (registry.get(worker.kind)) {
      throw new Error(`External worker kind is already registered: ${worker.kind}`);
    }

    registry.register(createExternalWorkerDefinition(worker));
  }

  return registry;
}

function createExternalWorkerDefinition(config: ExternalWorkerConfig): WorkerDefinition {
  return {
    kind: config.kind,
    note: `External process: ${config.launch.executable}`,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => createExternalWorkerRuntime(config, deps),
  };
}

function createExternalWorkerRuntime(
  config: ExternalWorkerConfig,
  deps: WorkerRuntimeDependencies,
): ExternalWorkerRuntime {
  const identity = {
    kind: config.kind,
    instanceId: `external-${++externalWorkerInstanceCounter}`,
  };
  const logger = deps.logger.child({ module: 'external-worker-loader', kind: config.kind });

  let child: ChildProcess | undefined;
  let exitPromise: Promise<void> | undefined;
  let stopping = false;

  const launch = (): Promise<void> => {
    if (exitPromise) return exitPromise;

    const args = config.launch.args ?? [];
    const env = createExternalWorkerEnvironment();
    logger.info('Starting external worker process', {
      executable: config.launch.executable,
      argCount: args.length,
      cwd: config.launch.cwd,
    });

    const spawned = spawn(config.launch.executable, args, {
      cwd: config.launch.cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child = spawned;

    const currentExitPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (child === spawned) child = undefined;
        if (error) reject(error);
        else resolve();
      };

      spawned.once('error', (error) => {
        logger.error('External worker process failed to start', { error });
        finish(error);
      });

      spawned.once('exit', (code, signal) => {
        const fields = { code, signal };
        if (stopping || code === 0) {
          logger.info('External worker process exited', fields);
          finish();
          return;
        }

        const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
        const error = new Error(`External worker "${config.kind}" exited with ${reason}`);
        logger.error(error.message, fields);
        finish(error);
      });
    });

    const trackedExitPromise = currentExitPromise.finally(() => {
      if (exitPromise === trackedExitPromise) exitPromise = undefined;
      stopping = false;
    });
    exitPromise = trackedExitPromise;
    return trackedExitPromise;
  };

  const stop = async (): Promise<void> => {
    const runningChild = child;
    const runningExit = exitPromise;
    if (!runningChild || !runningExit) return;

    stopping = true;
    if (runningChild.exitCode === null && !runningChild.killed) {
      runningChild.kill('SIGTERM');
    }

    const killTimer = setTimeout(() => {
      if (child === runningChild && runningChild.exitCode === null) {
        runningChild.kill('SIGKILL');
      }
    }, EXTERNAL_WORKER_SHUTDOWN_GRACE_MS);
    killTimer.unref?.();

    try {
      await runningExit.catch(() => undefined);
    } finally {
      clearTimeout(killTimer);
    }
  };

  return {
    [EXTERNAL_WORKER_RUNTIME]: true,
    identity,
    start(): void {
      void launch().catch(() => undefined);
    },
    wake(_reason?: WorkerTickReason): void {
      // External workers do their own work in their process; Invoker only owns lifecycle.
    },
    tick(_reason?: WorkerTickReason): Promise<void> {
      return launch();
    },
    stop,
    isRunning(): boolean {
      return child !== undefined;
    },
    waitForExit(): Promise<void> {
      return exitPromise ?? Promise.resolve();
    },
  };
}
