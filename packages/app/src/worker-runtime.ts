import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { Logger } from '@invoker/contracts';

import {
  type WorkflowLifecycleEvent,
  type WorkflowLifecycleEventKind,
} from './lifecycle-events.js';

/**
 * Default poll interval for a worker that is not given an explicit one.
 *
 * Polling is the safety net for events the worker never received (process was
 * starting up, bus hiccup, an external state change that emits no lifecycle
 * event). A startup scan plus this interval guarantees forward progress even
 * if every wakeup event is missed.
 */
export const DEFAULT_WORKER_POLL_INTERVAL_MS = 60_000;

/**
 * A generic, policy-free lifecycle worker.
 *
 * The runtime owns the *mechanics* of running recovery work — when to wake,
 * how to coalesce overlapping wakeups, how to poll for missed events, and how
 * to shut down cleanly — but holds **no** opinion about what the work is. The
 * caller injects two callbacks:
 *
 *   - `scan`   — discover the current batch of work items.
 *   - `submit` — act on one discovered item.
 *
 * A worker wakes up on three triggers: an optional startup scan, matching
 * `WORKFLOW_LIFECYCLE` events, and a periodic poll. Every trigger funnels into
 * a single serialized drain loop so `scan`/`submit` never run concurrently with
 * themselves; overlapping wakeups collapse into exactly one follow-up cycle.
 */
export interface WorkerRuntime {
  /** Request a scan cycle. Coalesces with any in-flight or pending cycle. */
  wake(): void;
  /** Stop the worker: detach the subscription, timer, and signal handlers. */
  stop(): void;
  /** Resolve once no cycle is in flight and none is pending. */
  waitForIdle(): Promise<void>;
  /** Resolve once the worker has stopped. */
  waitUntilStopped(): Promise<void>;
  /** Whether the worker has been stopped. */
  isStopped(): boolean;
}

export interface WorkerRuntimeOptions<TItem> {
  /** Bus carrying `Channels.WORKFLOW_LIFECYCLE` events. */
  readonly messageBus: MessageBus;
  /** Discover the current batch of work. Returning `undefined` means "nothing". */
  readonly scan: () => Promise<readonly TItem[] | undefined> | readonly TItem[] | undefined;
  /** Act on a single discovered item. */
  readonly submit: (item: TItem) => Promise<void> | void;
  /**
   * Wake on these lifecycle event kinds. Ignored when `predicate` is supplied.
   * When neither is set, every lifecycle event wakes the worker.
   */
  readonly eventKinds?: readonly WorkflowLifecycleEventKind[];
  /** Wake when this returns true. Takes precedence over `eventKinds`. */
  readonly predicate?: (event: WorkflowLifecycleEvent) => boolean;
  /** Periodic poll interval. Default: {@link DEFAULT_WORKER_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Run one scan when the worker starts. Default: true. */
  readonly scanOnStartup?: boolean;
  /** Register process SIGINT/SIGTERM handlers that stop the worker. Default: true. */
  readonly handleSignals?: boolean;
  readonly logger?: Logger;
  /** Label used in log lines. Default: "worker". */
  readonly name?: string;
}

export function startWorkerRuntime<TItem>(options: WorkerRuntimeOptions<TItem>): WorkerRuntime {
  const name = options.name ?? 'worker';
  const logger = options.logger;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const logModule = 'worker-runtime';

  let stopped = false;
  let draining = false;
  let pendingWake = false;
  let idleResolvers: Array<() => void> = [];
  const stoppedResolvers: Array<() => void> = [];

  const matches = (event: WorkflowLifecycleEvent): boolean => {
    if (options.predicate) return options.predicate(event);
    if (options.eventKinds) return options.eventKinds.includes(event.kind);
    return true;
  };

  const flushIdle = (): void => {
    if (draining || pendingWake) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const runCycle = async (): Promise<void> => {
    let items: readonly TItem[] | undefined;
    try {
      items = await options.scan();
    } catch (err) {
      logger?.error(`${name} scan failed`, { module: logModule, err });
      return;
    }
    for (const item of items ?? []) {
      if (stopped) return;
      try {
        await options.submit(item);
      } catch (err) {
        logger?.error(`${name} submit failed`, { module: logModule, err });
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pendingWake && !stopped) {
        pendingWake = false;
        await runCycle();
      }
    } finally {
      draining = false;
      flushIdle();
    }
  };

  const wake = (): void => {
    if (stopped) return;
    pendingWake = true;
    void drain();
  };

  const unsubscribe: Unsubscribe = options.messageBus.subscribe<WorkflowLifecycleEvent>(
    Channels.WORKFLOW_LIFECYCLE,
    (event) => {
      if (stopped) return;
      if (!matches(event)) return;
      wake();
    },
  );

  const interval = setInterval(() => {
    wake();
  }, pollIntervalMs);
  interval.unref?.();

  const onSignal = (): void => {
    stop();
  };

  if (options.handleSignals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    pendingWake = false;
    unsubscribe();
    clearInterval(interval);
    if (options.handleSignals !== false) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    logger?.info(`${name} stopped`, { module: logModule });
    flushIdle();
    const resolvers = stoppedResolvers.splice(0, stoppedResolvers.length);
    for (const resolve of resolvers) resolve();
  }

  logger?.info(`${name} started pollIntervalMs=${pollIntervalMs}`, { module: logModule });

  if (options.scanOnStartup !== false) {
    wake();
  }

  return {
    wake,
    stop,
    waitForIdle: () => {
      if (!draining && !pendingWake) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    waitUntilStopped: () => {
      if (stopped) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stoppedResolvers.push(resolve);
      });
    },
    isStopped: () => stopped,
  };
}
