/**
 * Shared runtime contract for long-running Invoker workers.
 *
 * A worker runtime is the reusable boundary that owns a worker's lifecycle:
 *   - identity   — a stable `kind` plus a unique `instanceId` per process
 *   - wakeup     — `wake()` requests an immediate tick outside the poll cadence
 *   - poll       — an optional periodic timer drives ticks on an interval
 *   - coalesce   — overlapping wake/poll requests collapse into a single
 *                  follow-up tick; ticks never run concurrently
 *   - shutdown   — `stop()` is deterministic and idempotent: it clears the
 *                  timer, drops SIGINT/SIGTERM handlers, and awaits the
 *                  in-flight tick before resolving
 *
 * This slice only establishes the contract. The recovery worker built on top
 * of it is intentionally behavior-neutral (its tick is a no-op by default), so
 * existing auto-fix paths keep running exactly as before — nothing is routed
 * through this runtime yet.
 */

import type { Logger } from '@invoker/contracts';
import {
  recordRecoveryWorkerStatus,
  type RecoveryWorkerRuntimeStatus,
} from './recovery-worker-observability.js';

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
}

/** The unit of work a worker performs on each tick. */
export type WorkerTick = (ctx: WorkerTickContext) => void | Promise<void>;

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
  /** Optional operator-facing status reporting. Best-effort and observational. */
  observability?: WorkerRuntimeObservabilityOptions;
}

export interface WorkerRuntimeObservabilityOptions {
  command: string;
  ownerId?: string;
  invokerHomeRoot?: string;
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
   * Deterministically stop: clear the timer, drop signal handlers, and await
   * any in-flight tick before resolving. Idempotent.
   */
  stop(): Promise<void>;
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
  const status: RecoveryWorkerRuntimeStatus | null = options.observability
    ? {
      kind: identity.kind,
      command: options.observability.command,
      instanceId: identity.instanceId,
      ownerId: options.observability.ownerId,
      pid: typeof process !== 'undefined' && process.pid ? process.pid : 0,
      state: 'created',
      intervalMs,
      tickCount: 0,
      wakeCount: 0,
      updatedAt: new Date().toISOString(),
    }
    : null;

  const publishStatus = (): void => {
    if (!status) return;
    try {
      recordRecoveryWorkerStatus(status, options.observability?.invokerHomeRoot);
    } catch (err) {
      options.logger.warn?.(`[worker:${identity.kind}] status update failed`, { ...logFields, err });
    }
  };

  const runOnce = async (reason: WorkerTickReason): Promise<void> => {
    tickNumber += 1;
    const ctx: WorkerTickContext = { identity, reason, tickNumber };
    if (status) {
      status.tickCount = tickNumber;
      status.lastScanAt = new Date().toISOString();
      status.lastScanReason = reason;
      status.lastError = undefined;
      publishStatus();
    }
    try {
      await options.onTick(ctx);
    } catch (err) {
      if (status) {
        status.lastError = err instanceof Error ? err.message : String(err);
      }
      options.logger.error(`[worker:${identity.kind}] tick failed`, { ...logFields, reason, err });
    } finally {
      publishStatus();
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
    if (status) {
      status.wakeCount += 1;
      status.lastWakeupAt = new Date().toISOString();
      status.lastWakeupReason = reason;
      publishStatus();
    }
    void schedule(reason);
  };

  const tick = (reason: WorkerTickReason = 'manual'): Promise<void> => schedule(reason);

  const start = (): void => {
    if (stopped) {
      throw new Error(`worker runtime ${identity.kind}/${identity.instanceId} cannot start after stop`);
    }
    if (started) return;
    started = true;
    if (status) {
      status.state = 'running';
      status.startedAt = new Date().toISOString();
      status.stoppedAt = undefined;
      publishStatus();
    }
    options.logger.info(
      `[worker:${identity.kind}] started intervalMs=${intervalMs} signals=${installSignalHandlers ? shutdownSignals.join(',') : 'none'}`,
      logFields,
    );

    if (installSignalHandlers) {
      for (const signal of shutdownSignals) {
        const handler = (): void => {
          options.logger.info(`[worker:${identity.kind}] received ${signal}; shutting down`, logFields);
          void stop();
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

  const stop = async (): Promise<void> => {
    if (stopped) {
      // Idempotent: a second stop still waits for any in-flight tick to settle.
      if (inFlight) await inFlight.catch(() => undefined);
      return;
    }
    stopped = true;
    pendingReason = null;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
    // Deterministic shutdown: never resolve while a tick is still running.
    if (inFlight) await inFlight.catch(() => undefined);
    if (status) {
      status.state = 'stopped';
      status.stoppedAt = new Date().toISOString();
      publishStatus();
    }
    options.logger.info(`[worker:${identity.kind}] stopped`, logFields);
  };

  const isRunning = (): boolean => started && !stopped;

  return { identity, start, wake, tick, stop, isRunning };
}

// ── Recovery worker ──────────────────────────────────────────

/** Public worker kind for the auto-fix recovery worker. */
export const RECOVERY_WORKER_KIND = 'recovery';

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 60_000;

export interface RecoveryWorkerOptions {
  logger: Logger;
  instanceId?: string;
  ownerId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  invokerHomeRoot?: string;
  /**
   * Behavior-neutral override for the tick. Defaults to a no-op for this slice:
   * the recovery worker does not submit recovery commands yet, and existing
   * auto-fix paths continue to run through their current owner.
   */
  onTick?: WorkerTick;
}

/**
 * Create the recovery worker runtime. By default its tick is a no-op so that
 * standing up the worker is behavior-neutral — no recovery commands are
 * submitted and no existing auto-fix path is rerouted in this slice.
 */
export function createRecoveryWorker(options: RecoveryWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: RECOVERY_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    observability: {
      command: 'autofix',
      ownerId: options.ownerId,
      invokerHomeRoot: options.invokerHomeRoot,
    },
    onTick: options.onTick ?? (() => {}),
  });
}
