import type { Logger } from '@invoker/contracts';
import { Channels } from '@invoker/transport';
import type { MessageBus, Unsubscribe } from '@invoker/transport';

import {
  isWorkerLifecycleEvent,
  type WorkerLifecycleEvent,
} from './lifecycle-events.js';

export const DEFAULT_WORKER_RUNTIME_POLL_INTERVAL_MS = 30_000;

export type WorkerRuntimeTrigger =
  | { readonly type: 'startup' }
  | { readonly type: 'poll' }
  | { readonly type: 'lifecycle'; readonly event: WorkerLifecycleEvent };

export interface WorkerRuntimeContext {
  readonly workerName: string;
  readonly trigger: WorkerRuntimeTrigger;
  readonly signal: AbortSignal;
}

export type WorkerRuntimeScan<TWorkItem> = (
  context: WorkerRuntimeContext,
) => readonly TWorkItem[] | Promise<readonly TWorkItem[]>;

export type WorkerRuntimeSubmit<TWorkItem> = (
  item: TWorkItem,
  context: WorkerRuntimeContext,
) => void | Promise<void>;

export interface WorkerRuntimeOptions<TWorkItem> {
  readonly name: string;
  readonly messageBus: MessageBus;
  readonly scan: WorkerRuntimeScan<TWorkItem>;
  readonly submit: WorkerRuntimeSubmit<TWorkItem>;
  readonly isRelevantEvent?: (event: WorkerLifecycleEvent) => boolean;
  readonly logger?: Pick<Logger, 'debug' | 'error' | 'info' | 'warn'>;
  readonly intervalMs?: number;
  readonly scanOnStart?: boolean;
  readonly installSignalHandlers?: boolean;
}

export interface WorkerRuntime {
  readonly stop: (reason?: string) => void;
  readonly requestScan: (trigger?: WorkerRuntimeTrigger) => void;
  readonly whenIdle: () => Promise<void>;
  readonly stopped: Promise<void>;
}

export function startWorkerRuntime<TWorkItem>(
  options: WorkerRuntimeOptions<TWorkItem>,
): WorkerRuntime {
  const intervalMs = options.intervalMs ?? DEFAULT_WORKER_RUNTIME_POLL_INTERVAL_MS;
  const abortController = new AbortController();
  const idleResolvers = new Set<() => void>();
  let stopped = false;
  let running = false;
  let queuedTrigger: WorkerRuntimeTrigger | undefined;
  let resolveStopped!: () => void;

  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const unsubscribe = options.messageBus.subscribe<unknown>(Channels.WORKFLOW_LIFECYCLE, (message) => {
    if (!isWorkerLifecycleEvent(message)) return;
    if (options.isRelevantEvent && !options.isRelevantEvent(message)) return;
    enqueueScan({ type: 'lifecycle', event: message });
  });

  const interval = setInterval(() => {
    enqueueScan({ type: 'poll' });
  }, intervalMs);
  interval.unref?.();

  const signalHandlers = options.installSignalHandlers === false
    ? []
    : (['SIGINT', 'SIGTERM'] as const).map((signal) => {
      const handler = () => stop(signal);
      process.once(signal, handler);
      return { signal, handler };
    });

  function enqueueScan(trigger: WorkerRuntimeTrigger): void {
    if (stopped) return;
    queuedTrigger = trigger;
    if (running) return;
    running = true;
    void drainScans();
  }

  async function drainScans(): Promise<void> {
    try {
      while (!stopped && queuedTrigger) {
        const trigger = queuedTrigger;
        queuedTrigger = undefined;
        await runScan(trigger);
      }
    } finally {
      running = false;
      if (!stopped && queuedTrigger) {
        running = true;
        void drainScans();
        return;
      }
      resolveIdleWaiters();
    }
  }

  async function runScan(trigger: WorkerRuntimeTrigger): Promise<void> {
    const context: WorkerRuntimeContext = {
      workerName: options.name,
      trigger,
      signal: abortController.signal,
    };
    try {
      const items = await options.scan(context);
      for (const item of items) {
        if (stopped || abortController.signal.aborted) return;
        await options.submit(item, context);
      }
    } catch (err) {
      options.logger?.error?.('worker runtime scan failed', {
        module: 'worker-runtime',
        workerName: options.name,
        triggerType: trigger.type,
        err,
      });
    }
  }

  function resolveIdleWaiters(): void {
    if (running || queuedTrigger) return;
    for (const resolve of idleResolvers) {
      resolve();
    }
    idleResolvers.clear();
  }

  function removeSignalHandlers(): void {
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }

  function stop(reason = 'stop'): void {
    if (stopped) return;
    stopped = true;
    queuedTrigger = undefined;
    clearInterval(interval);
    safeUnsubscribe(unsubscribe, options.logger);
    removeSignalHandlers();
    abortController.abort(reason);
    options.logger?.info?.('worker runtime stopped', {
      module: 'worker-runtime',
      workerName: options.name,
      reason,
    });
    resolveIdleWaiters();
    resolveStopped();
  }

  if (options.scanOnStart !== false) {
    enqueueScan({ type: 'startup' });
  }

  options.logger?.info?.('worker runtime started', {
    module: 'worker-runtime',
    workerName: options.name,
    intervalMs,
  });

  return {
    stop,
    requestScan: (trigger = { type: 'poll' }) => enqueueScan(trigger),
    whenIdle: () => {
      if (!running && !queuedTrigger) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleResolvers.add(resolve);
      });
    },
    stopped: stoppedPromise,
  };
}

function safeUnsubscribe(
  unsubscribe: Unsubscribe,
  logger: Pick<Logger, 'warn'> | undefined,
): void {
  try {
    unsubscribe();
  } catch (err) {
    logger?.warn?.('worker runtime unsubscribe failed', { module: 'worker-runtime', err });
  }
}
