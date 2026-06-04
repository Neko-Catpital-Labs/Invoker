import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import {
  isWorkflowLifecycleEvent,
  type WorkflowLifecycleEvent,
  type WorkflowLifecycleEventKind,
} from './lifecycle-events.js';

export type WorkerRuntimeTrigger =
  | { readonly kind: 'startup'; readonly at: Date }
  | { readonly kind: 'poll'; readonly at: Date }
  | { readonly kind: 'lifecycle'; readonly at: Date; readonly event: WorkflowLifecycleEvent }
  | { readonly kind: 'manual'; readonly at: Date; readonly reason?: string };

export interface WorkerRuntimeScanContext {
  readonly workerName: string;
  readonly trigger: WorkerRuntimeTrigger;
}

export interface WorkerRuntimeSubmitContext<TCandidate> extends WorkerRuntimeScanContext {
  readonly candidate: TCandidate;
}

export type WorkerRuntimeScan<TCandidate> = (
  context: WorkerRuntimeScanContext,
) => readonly TCandidate[] | Promise<readonly TCandidate[]>;

export type WorkerRuntimeSubmit<TCandidate> = (
  candidate: TCandidate,
  context: WorkerRuntimeSubmitContext<TCandidate>,
) => void | Promise<void>;

export type WorkerRuntimeLifecyclePredicate = (event: WorkflowLifecycleEvent) => boolean;

export interface WorkerRuntimeSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface WorkerRuntimeOptions<TCandidate> {
  readonly name: string;
  readonly messageBus: MessageBus;
  readonly logger: Logger;
  readonly scan: WorkerRuntimeScan<TCandidate>;
  readonly submit: WorkerRuntimeSubmit<TCandidate>;
  readonly pollIntervalMs?: number;
  readonly relevantLifecycleEvents?: readonly WorkflowLifecycleEventKind[] | WorkerRuntimeLifecyclePredicate;
  readonly startImmediately?: boolean;
  readonly signalTarget?: WorkerRuntimeSignalTarget;
  readonly signalNames?: readonly NodeJS.Signals[];
  readonly now?: () => Date;
}

export interface WorkerRuntimeController {
  wake(reason?: string): Promise<void>;
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
  waitUntilStopped(): Promise<void>;
  isStopped(): boolean;
}

export const DEFAULT_WORKER_RUNTIME_POLL_INTERVAL_MS = 30_000;

export function startWorkerRuntime<TCandidate>(
  options: WorkerRuntimeOptions<TCandidate>,
): WorkerRuntimeController {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_RUNTIME_POLL_INTERVAL_MS;
  const signalNames = options.signalNames ?? ['SIGINT', 'SIGTERM'];
  const signalTarget = options.signalTarget ?? process;
  const now = options.now ?? (() => new Date());

  let stopped = false;
  let stoppedResolved = false;
  let queuedTrigger: WorkerRuntimeTrigger | undefined;
  let activeDrain: Promise<void> | null = null;
  let unsubscribeLifecycle: Unsubscribe | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const signalHandlers = signalNames.map((signal) => {
    const listener = (): void => {
      options.logger.info('worker runtime received shutdown signal', {
        module: 'worker-runtime',
        worker: options.name,
        signal,
      });
      void stop();
    };
    signalTarget.once(signal, listener);
    return { signal, listener };
  });

  const isRelevantLifecycleEvent = buildLifecyclePredicate(options.relevantLifecycleEvents);

  const cleanup = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (unsubscribeLifecycle) {
      unsubscribeLifecycle();
      unsubscribeLifecycle = undefined;
    }
    for (const { signal, listener } of signalHandlers) {
      signalTarget.removeListener(signal, listener);
    }
  };

  const resolveStoppedOnce = (): void => {
    if (stoppedResolved) return;
    stoppedResolved = true;
    options.logger.info('worker runtime stopped', {
      module: 'worker-runtime',
      worker: options.name,
    });
    resolveStopped();
  };

  const schedule = (trigger: WorkerRuntimeTrigger): void => {
    if (stopped) return;
    queuedTrigger = trigger;
    if (!activeDrain) {
      activeDrain = drain();
    }
  };

  const runScan = async (trigger: WorkerRuntimeTrigger): Promise<void> => {
    let candidates: readonly TCandidate[];
    try {
      candidates = await options.scan({
        workerName: options.name,
        trigger,
      });
    } catch (err) {
      options.logger.error('worker runtime scan failed', {
        module: 'worker-runtime',
        worker: options.name,
        triggerKind: trigger.kind,
        err,
      });
      return;
    }

    for (const candidate of candidates) {
      if (stopped) break;
      try {
        await options.submit(candidate, {
          workerName: options.name,
          trigger,
          candidate,
        });
      } catch (err) {
        options.logger.error('worker runtime submit failed', {
          module: 'worker-runtime',
          worker: options.name,
          triggerKind: trigger.kind,
          err,
        });
      }
    }
  };

  const drain = async (): Promise<void> => {
    try {
      while (!stopped && queuedTrigger) {
        const trigger = queuedTrigger;
        queuedTrigger = undefined;
        await runScan(trigger);
      }
    } finally {
      activeDrain = null;
      if (stopped) {
        resolveStoppedOnce();
      }
    }
  };

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      queuedTrigger = undefined;
      cleanup();
      if (!activeDrain) {
        resolveStoppedOnce();
      }
    }
    return stoppedPromise;
  };

  unsubscribeLifecycle = options.messageBus.subscribe<unknown>(Channels.WORKFLOW_LIFECYCLE, (message) => {
    if (!isWorkflowLifecycleEvent(message)) {
      options.logger.warn('worker runtime ignored malformed lifecycle event', {
        module: 'worker-runtime',
        worker: options.name,
      });
      return;
    }
    if (!isRelevantLifecycleEvent(message)) return;
    schedule({ kind: 'lifecycle', at: now(), event: message });
  });

  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      schedule({ kind: 'poll', at: now() });
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  options.logger.info('worker runtime started', {
    module: 'worker-runtime',
    worker: options.name,
    pollIntervalMs,
  });

  if (options.startImmediately !== false) {
    schedule({ kind: 'startup', at: now() });
  }

  return {
    wake: async (reason?: string) => {
      schedule({ kind: 'manual', at: now(), ...(reason ? { reason } : {}) });
      await (activeDrain ?? Promise.resolve());
    },
    stop,
    waitForIdle: async () => {
      await (activeDrain ?? Promise.resolve());
    },
    waitUntilStopped: () => stoppedPromise,
    isStopped: () => stopped,
  };
}

export async function runWorkerRuntime<TCandidate>(
  options: WorkerRuntimeOptions<TCandidate>,
): Promise<void> {
  const runtime = startWorkerRuntime(options);
  await runtime.waitUntilStopped();
}

function buildLifecyclePredicate(
  relevantLifecycleEvents: WorkerRuntimeOptions<unknown>['relevantLifecycleEvents'],
): WorkerRuntimeLifecyclePredicate {
  if (typeof relevantLifecycleEvents === 'function') {
    return relevantLifecycleEvents;
  }
  if (Array.isArray(relevantLifecycleEvents)) {
    const relevantKinds = new Set<WorkflowLifecycleEventKind>(relevantLifecycleEvents);
    return (event) => relevantKinds.has(event.kind);
  }
  return () => true;
}
