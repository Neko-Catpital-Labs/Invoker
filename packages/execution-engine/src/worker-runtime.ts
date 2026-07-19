import type { Logger } from '@invoker/contracts';

export type WorkerTickReason = 'startup' | 'poll' | 'wake' | 'manual';

export interface WorkerIdentity {
  readonly kind: string;
  readonly instanceId: string;
}

export interface WorkerTickContext {
  readonly identity: WorkerIdentity;
  readonly reason: WorkerTickReason;
  readonly tickNumber: number;
  readonly signal: AbortSignal;
}

export type WorkerTick = (ctx: WorkerTickContext) => void | Promise<void>;

export interface WorkerRuntimeStopOptions {
  settleTimeoutMs?: number;
}

export interface WorkerRuntimeOptions {
  kind: string;
  instanceId?: string;
  logger: Logger;
  onTick: WorkerTick;
  intervalMs?: number;
  tickOnStart?: boolean;
  shutdownSignals?: NodeJS.Signals[];
  installSignalHandlers?: boolean;
}

export interface WorkerRuntime {
  readonly identity: WorkerIdentity;
  start(): void;
  wake(reason?: WorkerTickReason): void;
  tick(reason?: WorkerTickReason): Promise<void>;
  stop(options?: WorkerRuntimeStopOptions): Promise<void>;
  isRunning(): boolean;
}

const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

let instanceCounter = 0;

function nextInstanceId(kind: string): string {
  instanceCounter += 1;
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  return `${kind}-${pid}-${instanceCounter}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const identity: WorkerIdentity = {
    kind: options.kind,
    instanceId: options.instanceId ?? nextInstanceId(options.kind),
  };
  const intervalMs = options.intervalMs ?? 0;
  const tickOnStart = options.tickOnStart ?? true;
  const shutdownSignals = options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const logFields = { module: 'worker-runtime', kind: identity.kind, instanceId: identity.instanceId };

  let started = false;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let pendingReason: WorkerTickReason | null = null;
  let tickNumber = 0;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let abortController = new AbortController();

  const runOnce = async (reason: WorkerTickReason): Promise<void> => {
    tickNumber += 1;
    const ctx: WorkerTickContext = {
      identity,
      reason,
      tickNumber,
      signal: abortController.signal,
    };
    try {
      await options.onTick(ctx);
    } catch (err) {
      if (abortController.signal.aborted) {
        options.logger.info(`[worker:${identity.kind}] tick aborted`, { ...logFields, reason });
        return;
      }
      options.logger.error(`[worker:${identity.kind}] tick failed`, { ...logFields, reason, err });
    }
  };

  const schedule = (reason: WorkerTickReason): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      pendingReason = reason;
      return inFlight;
    }
    const drain = async (firstReason: WorkerTickReason): Promise<void> => {
      let nextReason: WorkerTickReason | null = firstReason;
      while (nextReason !== null && !stopped) {
        const current = nextReason;
        pendingReason = null;
        await runOnce(current);
        nextReason = pendingReason;
      }
    };
    inFlight = drain(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const wake = (reason: WorkerTickReason = 'wake'): void => {
    if (stopped) return;
    void schedule(reason);
  };

  const tick = (reason: WorkerTickReason = 'manual'): Promise<void> => schedule(reason);

  const beginStop = (): void => {
    if (stopped) return;
    stopped = true;
    pendingReason = null;
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };

  const settleInFlight = async (settleTimeoutMs: number): Promise<void> => {
    if (!inFlight || settleTimeoutMs <= 0) return;
    let settled = false;
    await Promise.race([
      inFlight.catch(() => undefined).then(() => {
        settled = true;
      }),
      delay(settleTimeoutMs),
    ]);
    if (!settled) {
      options.logger.warn(`[worker:${identity.kind}] settle timed out after abort`, {
        ...logFields,
        settleTimeoutMs,
        tickNumber,
      });
    }
  };

  const start = (): void => {
    if (stopped) {
      throw new Error(`worker runtime ${identity.kind}/${identity.instanceId} cannot start after stop`);
    }
    if (started) return;
    started = true;

    if (installSignalHandlers) {
      for (const signal of shutdownSignals) {
        const handler = (): void => {
          void stop({ settleTimeoutMs: 5_000 });
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    if (intervalMs > 0) {
      interval = setInterval(() => wake('poll'), intervalMs);
      interval.unref?.();
    }

    if (tickOnStart) wake('startup');
  };

  const stop = async (stopOptions?: WorkerRuntimeStopOptions): Promise<void> => {
    const settleTimeoutMs = stopOptions?.settleTimeoutMs ?? 0;
    if (stopped) {
      await settleInFlight(settleTimeoutMs);
      return;
    }
    beginStop();
    await settleInFlight(settleTimeoutMs);
  };

  const isRunning = (): boolean => started && !stopped;

  return { identity, start, wake, tick, stop, isRunning };
}
