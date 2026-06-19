/**
 * Generic lifecycle worker runtime.
 *
 * This is a policy-free engine for long-lived background workers (auto-fix,
 * external-recovery, …). It owns the *mechanics* — when to wake up, how to
 * coalesce overlapping wakeups, how to poll, and how to shut down — while the
 * *policy* (what to look for and what to do about it) is injected via the
 * `scan` and `submit` callbacks.
 *
 * A worker wakes up on three triggers:
 *   1. A startup scan (on by default) so it reconciles state it missed while down.
 *   2. Matching `Channels.WORKFLOW_LIFECYCLE` events.
 *   3. A periodic poll, so events dropped while the worker was busy still get
 *      picked up eventually.
 *
 * On every wakeup the runtime runs one cycle: `scan()` returns a batch of items
 * and `submit()` is invoked once per item. Wakeups that arrive while a cycle is
 * already running are coalesced into a single follow-up cycle.
 */

import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';

import {
  isWorkflowLifecycleEvent,
  type WorkflowLifecycleEvent,
  type WorkflowLifecycleEventKind,
} from './lifecycle-events.js';

export const DEFAULT_WORKER_POLL_INTERVAL_MS = 30_000;

export interface WorkerRuntimeOptions<T> {
  /** Human-readable worker name, used for log context. */
  readonly name: string;
  readonly messageBus: MessageBus;
  readonly logger: Logger;
  /**
   * Discover the work that should be acted on right now. Called once per
   * wakeup cycle. May be async. Errors are logged and end the cycle.
   */
  readonly scan: () => Promise<readonly T[]> | readonly T[];
  /**
   * Act on a single item discovered by `scan`. Called once per item. May be
   * async. Errors are logged per-item and do not abort the rest of the batch.
   */
  readonly submit: (item: T) => Promise<void> | void;
  /**
   * Lifecycle event kinds that should wake the worker. Ignored when
   * `eventFilter` is provided. When neither is set, every lifecycle event wakes
   * the worker.
   */
  readonly eventKinds?: readonly WorkflowLifecycleEventKind[];
  /** Predicate deciding whether a lifecycle event should wake the worker. */
  readonly eventFilter?: (event: WorkflowLifecycleEvent) => boolean;
  /** Polling interval in ms. Default: {@link DEFAULT_WORKER_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Run a scan immediately on start. Default: true. */
  readonly runStartupScan?: boolean;
  /** Register SIGINT/SIGTERM handlers that stop the worker. Default: true. */
  readonly registerSignalHandlers?: boolean;
}

export interface WorkerRuntime {
  /** Request a wakeup cycle now (coalesced with any in-flight cycle). */
  wake(): void;
  /** Stop the worker: clear the poll, drop subscriptions and signal handlers. */
  stop(): void;
  /** Resolves once no cycle is running and no wakeup is pending. */
  waitForIdle(): Promise<void>;
  /** Resolves once the worker has stopped. */
  waitUntilStopped(): Promise<void>;
  /** Whether {@link stop} has been called. */
  isStopped(): boolean;
}

export function startWorkerRuntime<T>(options: WorkerRuntimeOptions<T>): WorkerRuntime {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const runStartupScan = options.runStartupScan ?? true;
  const registerSignalHandlers = options.registerSignalHandlers ?? true;
  const logContext = { module: 'worker-runtime', worker: options.name };

  let stopped = false;
  let running = false;
  let pending = false;
  const idleWaiters: Array<() => void> = [];
  const stoppedWaiters: Array<() => void> = [];

  const matchesEvent = (event: WorkflowLifecycleEvent): boolean => {
    if (options.eventFilter) return options.eventFilter(event);
    if (options.eventKinds) return options.eventKinds.includes(event.kind);
    return true;
  };

  const resolveIdleWaiters = (): void => {
    if (running || pending) return;
    while (idleWaiters.length > 0) {
      idleWaiters.shift()?.();
    }
  };

  const runCycle = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      // Coalesce: a cycle is already running; mark a follow-up instead of
      // running a second cycle concurrently.
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        let items: readonly T[];
        try {
          items = await options.scan();
        } catch (err) {
          options.logger.error('worker scan failed', { ...logContext, err });
          break;
        }
        for (const item of items) {
          if (stopped) break;
          try {
            await options.submit(item);
          } catch (err) {
            options.logger.error('worker submit failed', { ...logContext, err });
          }
        }
      } while (pending && !stopped);
    } finally {
      running = false;
      resolveIdleWaiters();
    }
  };

  const wake = (): void => {
    if (stopped) return;
    void runCycle();
  };

  const subscription: Unsubscribe = options.messageBus.subscribe<unknown>(
    Channels.WORKFLOW_LIFECYCLE,
    (message) => {
      if (stopped) return;
      if (!isWorkflowLifecycleEvent(message)) return;
      if (!matchesEvent(message)) return;
      wake();
    },
  );

  const interval = setInterval(() => {
    if (stopped) return;
    wake();
  }, pollIntervalMs);
  interval.unref?.();

  const handleSignal = (): void => {
    stop();
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    subscription();
    if (registerSignalHandlers) {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    }
    // A stopped worker is also idle; release anything waiting on either.
    resolveIdleWaiters();
    while (idleWaiters.length > 0) idleWaiters.shift()?.();
    while (stoppedWaiters.length > 0) stoppedWaiters.shift()?.();
    options.logger.info('worker stopped', logContext);
  }

  if (registerSignalHandlers) {
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  }

  options.logger.info(`worker started pollIntervalMs=${pollIntervalMs}`, logContext);

  if (runStartupScan) {
    wake();
  }

  return {
    wake,
    stop,
    isStopped: () => stopped,
    waitForIdle: () =>
      new Promise<void>((resolve) => {
        if (!running && !pending) {
          resolve();
          return;
        }
        idleWaiters.push(resolve);
      }),
    waitUntilStopped: () =>
      new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        stoppedWaiters.push(resolve);
      }),
  };
}
