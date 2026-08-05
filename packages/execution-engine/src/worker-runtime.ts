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
  /**
   * Delay before the poll interval (and `tickOnStart`) begin, in ms. Default 0.
   * Use to stagger multiple worker runtimes that share an external resource
   * (e.g. a cross-process lock) and would otherwise all wake on the same
   * `intervalMs` boundary every cycle.
   */
  startDelayMs?: number;
  /** Run a tick immediately when `start()` is called. Default `true`. */
  tickOnStart?: boolean;
  /** Initial delay before a queued follow-up tick after a failed tick. Default 250ms. */
  backoffBaseMs?: number;
  /** Maximum delay before a queued follow-up tick after repeated failures. Default 30s. */
  backoffMaxMs?: number;
  /** OS signals that trigger deterministic shutdown. Default `SIGINT`/`SIGTERM`. */
  shutdownSignals?: NodeJS.Signals[];
  /** Install process signal handlers on `start()`. Default `true`. */
  installSignalHandlers?: boolean;
  /**
   * When > 0 and a shutdown signal stopped this runtime but the process is
   * still alive this many ms later, log an error and restart the runtime.
   * A signal a long-lived owner survives must not permanently strip its
   * workers (2026-08-05: a SIGTERM the owner outlived silently killed all
   * PR-maintenance workers for over an hour). Default 0 (signal stop is
   * final), preserving shutdown semantics for processes that exit.
   */
  restartAfterSurvivedSignalMs?: number;
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
  const startDelayMs = options.startDelayMs ?? 0;
  const tickOnStart = options.tickOnStart ?? true;
  const shutdownSignals = options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const logFields = { module: 'worker-runtime', kind: identity.kind, instanceId: identity.instanceId };

  let started = false;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let startDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let pendingReason: WorkerTickReason | null = null;
  let tickNumber = 0;
  let lastTickActivityAt = Date.now();
  let watchdogTimer: NodeJS.Timeout | null = null;
  let stallLogged = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let abortController = new AbortController();

  const runOnce = async (reason: WorkerTickReason): Promise<boolean> => {
    tickNumber += 1;
    const ctx: WorkerTickContext = {
      identity,
      reason,
      tickNumber,
      signal: abortController.signal,
    };
    lastTickActivityAt = Date.now();
    try {
      await options.onTick(ctx);
      return true;
    } catch (err) {
      if (abortController.signal.aborted) {
        options.logger.info(`[worker:${identity.kind}] tick aborted`, { ...logFields, reason });
        return true;
      }
      options.logger.error(`[worker:${identity.kind}] tick failed`, { ...logFields, reason, err });
      return false;
    } finally {
      lastTickActivityAt = Date.now();
      stallLogged = false;
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
      let consecutiveFailures = 0;
      while (nextReason !== null && !stopped) {
        const current = nextReason;
        pendingReason = null;
        const succeeded = await runOnce(current);
        consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
        nextReason = pendingReason;
        if (nextReason !== null && !succeeded && !stopped) {
          const backoffMs = Math.min(
            (options.backoffBaseMs ?? 250) * 2 ** (consecutiveFailures - 1),
            options.backoffMaxMs ?? 30_000,
          );
          await delay(backoffMs);
        }
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
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (startDelayTimer) {
      clearTimeout(startDelayTimer);
      startDelayTimer = null;
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
      `[worker:${identity.kind}] started intervalMs=${intervalMs} startDelayMs=${startDelayMs} signals=${installSignalHandlers ? shutdownSignals.join(',') : 'none'}`,
      logFields,
    );

    if (installSignalHandlers) {
      for (const signal of shutdownSignals) {
        const handler = (): void => {
          options.logger.info(`[worker:${identity.kind}] received ${signal}; shutting down`, logFields);
          const stopping = stop({ settleTimeoutMs: 5_000 });
          const restartMs = options.restartAfterSurvivedSignalMs ?? 0;
          if (restartMs <= 0) return;
          void stopping.then(() => {
            const timer = setTimeout(() => {
              options.logger.error(
                `[worker:${identity.kind}] process survived ${signal} for ${restartMs}ms after worker stop; restarting worker`,
                logFields,
              );
              stopped = false;
              started = false;
              abortController = new AbortController();
              start();
            }, restartMs);
            timer.unref?.();
          });
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    const beginPolling = (): void => {
      if (intervalMs > 0) {
        interval = setInterval(() => wake('poll'), intervalMs);
        interval.unref?.();
        lastTickActivityAt = Date.now();
        stallLogged = false;
        watchdogTimer = setInterval(() => {
          const idleMs = Date.now() - lastTickActivityAt;
          if (idleMs > intervalMs * 2 && !stallLogged) {
            stallLogged = true;
            options.logger.error(
              `[worker:${identity.kind}] no tick activity for ${idleMs}ms (interval ${intervalMs}ms) — worker looks stalled`,
              { ...logFields, tickNumber },
            );
          }
        }, intervalMs);
        watchdogTimer.unref?.();
      }
      if (tickOnStart) wake('startup');
    };

    if (startDelayMs > 0) {
      startDelayTimer = setTimeout(() => {
        startDelayTimer = null;
        if (!stopped) beginPolling();
      }, startDelayMs);
      startDelayTimer.unref?.();
    } else {
      beginPolling();
    }
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
