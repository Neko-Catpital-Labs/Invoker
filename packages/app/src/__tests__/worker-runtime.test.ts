import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';

import { startWorkerRuntime } from '../worker-runtime.js';
import {
  buildTaskUpdatedLifecycleEvent,
  type WorkflowLifecycleEvent,
} from '../lifecycle-events.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function lifecycleEvent(status: 'failed' | 'completed'): WorkflowLifecycleEvent {
  return buildTaskUpdatedLifecycleEvent({
    workflowId: 'wf-1',
    taskId: 'wf-1/root',
    status,
    taskStateVersion: 1,
    generation: 0,
  });
}

describe('worker-runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('wakes and scans when a matching lifecycle event arrives, ignoring others', async () => {
    const bus = new LocalBus();
    const submitted: string[] = [];
    const scan = vi.fn(() => ['work']);

    const worker = startWorkerRuntime<string>({
      messageBus: bus,
      scan,
      submit: (item) => {
        submitted.push(item);
      },
      eventKinds: ['task.failed'],
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000_000,
      logger,
    });

    // A non-matching kind must not wake the worker.
    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('completed'));
    await worker.waitForIdle();
    expect(scan).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);

    // A matching kind triggers exactly one scan + submit.
    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('failed'));
    await worker.waitForIdle();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual(['work']);

    worker.stop();
  });

  it('runs a startup scan by default', async () => {
    const bus = new LocalBus();
    const scan = vi.fn(() => []);

    const worker = startWorkerRuntime({
      messageBus: bus,
      scan,
      submit: () => {},
      handleSignals: false,
      pollIntervalMs: 1_000_000,
    });

    await worker.waitForIdle();
    expect(scan).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('coalesces overlapping wakeups into a single follow-up cycle', async () => {
    const bus = new LocalBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async () => {
      await gate;
      return [] as string[];
    });

    const worker = startWorkerRuntime<string>({
      messageBus: bus,
      scan,
      submit: () => {},
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000_000,
    });

    // First wake starts a cycle that is now parked on `gate`.
    worker.wake();
    // Three more wakes while one is in flight collapse into ONE re-run.
    worker.wake();
    worker.wake();
    worker.wake();

    release();
    await worker.waitForIdle();

    // One in-flight cycle + one coalesced follow-up = 2 scans, not 4.
    expect(scan).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it('polls on an interval to recover work missed by lifecycle events', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const submitted: string[] = [];
    // Lifecycle events were never delivered; the poll is the only trigger.
    const scan = vi.fn(() => ['missed-recovery']);

    const worker = startWorkerRuntime<string>({
      messageBus: bus,
      scan,
      submit: (item) => {
        submitted.push(item);
      },
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000,
    });

    expect(scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual(['missed-recovery']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it('stops cleanly: detaches subscription, timer, and signal handlers', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const scan = vi.fn(() => []);

    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const worker = startWorkerRuntime({
      messageBus: bus,
      scan,
      submit: () => {},
      scanOnStartup: false,
      pollIntervalMs: 1_000,
    });

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);

    const stoppedPromise = worker.waitUntilStopped();
    worker.stop();

    expect(worker.isStopped()).toBe(true);
    await expect(stoppedPromise).resolves.toBeUndefined();

    // Signal handlers removed.
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);

    // Timer cleared — advancing time does not scan.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scan).not.toHaveBeenCalled();

    // Subscription removed — a matching event does not wake the worker.
    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('failed'));
    await worker.waitForIdle();
    expect(scan).not.toHaveBeenCalled();

    // stop() is idempotent.
    worker.stop();
    expect(worker.isStopped()).toBe(true);
  });
});
