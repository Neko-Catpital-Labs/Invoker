/**
 * Shared runtime contract for long-running Invoker workers.
 *
 * A worker runtime is the reusable boundary that owns a worker's lifecycle:
 *   - identity   — a stable `kind` plus a unique `instanceId` per process
 *   - wakeup     — `wake()` requests an immediate tick outside the poll cadence
 *   - poll       — an optional periodic timer drives ticks on an interval
 *   - coalesce   — overlapping wake/poll requests collapse into a single
 *                  follow-up tick; ticks never run concurrently
 *   - shutdown   — `stop()` requests cooperative cancel via AbortSignal and
 *                  returns promptly; callers that need deterministic cleanup
 *                  (quit / stopAll) pass `settleTimeoutMs` for a bounded wait
 */

import type { Logger } from '@invoker/contracts';

/** Why a given tick is running. */
export type WorkerTickReason = 'startup' | 'poll' | 'wake' | 'manual';

/** Stable identity for a worker runtime instance. */
export interface WorkerIdentity {
  /** Worker family, e.g. `'recovery'`. Shared across instances. */
  readonly kind: string;
  /** Unique id for this runtime instance within the process. */
  readonly instanceId: string;
}

/** Context handed to every tick. */
export interface WorkerTickContext {
  readonly identity: WorkerIdentity;
  /** What triggered this tick. */
  readonly reason: WorkerTickReason;
  /** 1-based count of ticks that have started for this runtime. */
  readonly tickNumber: number;
  /** Aborted when `stop()` is requested; ticks should check between units of work. */
  readonly signal: AbortSignal;
}

/** The unit of work a worker performs on each tick. */
export type WorkerTick = (ctx: WorkerTickContext) => void | Promise<void>;

export interface WorkerRuntimeStopOptions {
  /**
   * When > 0, wait up to this many ms for an in-flight tick after cancel.
   * Default 0: return as soon as cancel is requested (GUI IPC path).
   */
  settleTimeoutMs?: number;
}

export interface WorkerRuntimeOptions {
  /** Worker family. Combined with `instanceId` to form the identity. */
  kind: string;
  /** Explicit instance id. Generated deterministically per process when omitted. */
  instanceId?: string;
  logger: Logger;
  /** Work performed on every tick. */
  onTick: WorkerTick;
  /** Periodic poll interval in ms. `<= 0` disables polling (wakeup-only). */
  intervalMs?: number;
  /** Run a tick immediately when `start()` is called. Default `true`. */
  tickOnStart?: boolean;
  /** OS signals that trigger deterministic shutdown. Default `SIGINT`/`SIGTERM`. */
  shutdownSignals?: NodeJS.Signals[];
  /** Install process signal handlers on `start()`. Default `true`. */
  installSignalHandlers?: boolean;
}

export interface WorkerRuntime {
  /** Stable identity for this runtime. */
  readonly identity: WorkerIdentity;
  /** Begin polling and (optionally) install signal handlers. Idempotent. */
  start(): void;
  /** Request a coalesced tick outside the poll cadence. */
  wake(reason?: WorkerTickReason): void;
  /** Run a single tick now and await it (manual/test hook). */
  tick(reason?: WorkerTickReason): Promise<void>;
  /**
   * Request stop: clear the timer, drop signal handlers, abort the tick
   * signal. Resolves promptly unless `settleTimeoutMs` is set for a bounded
   * wait on the in-flight tick. Idempotent.
   */
  stop(options?: WorkerRuntimeStopOptions): Promise<void>;
  /** True between `start()` and `stop()`. */
  isRunning(): boolean;
}

const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

let instanceCounter = 0;

/** Deterministic, collision-free instance id within a single process. */
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

/**
 * Create a worker runtime around `onTick`. The runtime does not start until
 * `start()` is called.
 */
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

  // Coalescing scheduler: at most one tick runs at a time. Requests that arrive
  // while a tick is in flight collapse into a single follow-up (keeping the most
  // recent reason), so a burst of wakeups never queues a backlog of ticks.
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
      if (inFlight) {
        options.logger.warn(`[worker:${identity.kind}] aborting in-flight tick`, {
          ...logFields,
          tickNumber,
          reason: 'stop',
        });
      } else {
        options.logger.info(`[worker:${identity.kind}] stop requested`, logFields);
      }
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
    options.logger.info(
      `[worker:${identity.kind}] started intervalMs=${intervalMs} signals=${installSignalHandlers ? shutdownSignals.join(',') : 'none'}`,
      logFields,
    );

    if (installSignalHandlers) {
      for (const signal of shutdownSignals) {
        const handler = (): void => {
          options.logger.info(`[worker:${identity.kind}] received ${signal}; shutting down`, logFields);
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
    options.logger.info(`[worker:${identity.kind}] stopped`, logFields);
  };

  const isRunning = (): boolean => started && !stopped;

  return { identity, start, wake, tick, stop, isRunning };
}
