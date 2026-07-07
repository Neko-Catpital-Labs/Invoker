import { spawn, type ChildProcess } from 'node:child_process';

import type { WorkerRegistry } from './worker-registry.js';
import type { WorkerRuntime } from './worker-runtime.js';

const STOP_TIMEOUT_MS = 5_000;

export interface ExternalWorkerLaunchConfig {
  /** Executable used to start the external worker process. */
  executable: string;
  /** Optional argv passed after the executable. */
  args?: readonly string[];
  /** Optional process working directory for the worker launch. */
  cwd?: string;
}

export interface ExternalWorkerConfig {
  /** Stable worker registry kind declared by the operator. */
  kind: string;
  /** Process invocation used to start the external worker. */
  launch: ExternalWorkerLaunchConfig;
}

export interface ExternalWorkerRuntime extends WorkerRuntime {
  /** Resolves when the supervised external process exits or the runtime stops before launch. */
  readonly finished: Promise<void>;
}
type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}


function delay(ms: number): Promise<void> {
  const { promise, resolve } = createDeferred<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  return promise;
}

function createExternalWorkerRuntime(config: ExternalWorkerConfig): ExternalWorkerRuntime {
  const identity = {
    kind: config.kind,
    instanceId: `external-${config.kind}-${process.pid}`,
  };
  const finishedGate = createDeferred<void>();

  let child: ChildProcess | null = null;
  let closePromise: Promise<void> | null = null;
  let started = false;
  let stopped = false;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    finishedGate.resolve();
  };

  const launch = (): void => {
    if (stopped) return;
    if (closePromise) return;

    const childProcess = spawn(config.launch.executable, [...(config.launch.args ?? [])], {
      cwd: config.launch.cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child = childProcess;

    const closeGate = createDeferred<void>();
    let closed = false;
    const settle = (): void => {
      if (closed) return;
      closed = true;
      child = null;
      finish();
      closeGate.resolve();
    };

    childProcess.once('error', settle);
    childProcess.once('close', settle);
    closePromise = closeGate.promise;
  };

  const start = (): void => {
    if (stopped) {
      throw new Error(`external worker ${identity.kind}/${identity.instanceId} cannot start after stop`);
    }
    if (started) return;
    started = true;
    void launch();
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      if (closePromise) await closePromise.catch(() => undefined);
      return;
    }
    stopped = true;

    const activeChild = child;
    if (!activeChild) {
      finish();
      return;
    }

    if (!activeChild.killed) {
      activeChild.kill('SIGTERM');
    }

    await Promise.race([
      closePromise ?? Promise.resolve(),
      delay(STOP_TIMEOUT_MS).then(() => {
        if (child) child.kill('SIGKILL');
      }),
    ]).catch(() => undefined);
  };

  const tick = async (): Promise<void> => {
    launch();
  };

  return {
    identity,
    finished: finishedGate.promise,
    start,
    wake: () => {
      void launch();
    },
    tick,
    stop,
    isRunning: () => started && !stopped && child !== null,
  };
}

export function registerExternalWorkers<TDeps>(
  registry: WorkerRegistry<TDeps>,
  externalWorkers: readonly ExternalWorkerConfig[] | undefined,
): WorkerRegistry<TDeps> {
  for (const config of externalWorkers ?? []) {
    registry.register({
      kind: config.kind,
      note: `Supervises external worker process ${config.launch.executable}.`,
      source: 'external',
      factory: (_deps: TDeps) => createExternalWorkerRuntime(config),
    });
  }
  return registry;
}
