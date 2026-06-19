import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';
import type { Logger } from '@invoker/contracts';

import {
  buildTaskUpdatedLifecycleEvent,
  buildWorkflowWakeupLifecycleEvent,
  type WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import { startWorkerRuntime, type WorkerRuntime } from '../worker-runtime.js';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function failedEvent(taskId = 'task-1'): WorkflowLifecycleEvent {
  return buildTaskUpdatedLifecycleEvent({
    workflowId: 'wf-1',
    taskId,
    status: 'failed',
    taskStateVersion: 1,
  });
}

function completedEvent(taskId = 'task-1'): WorkflowLifecycleEvent {
  return buildTaskUpdatedLifecycleEvent({
    workflowId: 'wf-1',
    taskId,
    status: 'completed',
    taskStateVersion: 1,
  });
}

function wakeupEvent(): WorkflowLifecycleEvent {
  return buildWorkflowWakeupLifecycleEvent({ workflowId: 'wf-1', reason: 'manual_reconcile' });
}

describe('worker-runtime', () => {
  let bus: LocalBus;
  let runtime: WorkerRuntime | undefined;

  beforeEach(() => {
    bus = new LocalBus();
    runtime = undefined;
  });

  afterEach(() => {
    runtime?.stop();
    bus.disconnect();
    vi.useRealTimers();
  });

  it('runs a startup scan by default', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'test',
      messageBus: bus,
      logger: makeLogger(),
      scan,
      submit: vi.fn(),
      registerSignalHandlers: false,
    });

    await runtime.waitForIdle();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('skips the startup scan when runStartupScan is false', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'test',
      messageBus: bus,
      logger: makeLogger(),
      scan,
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();
  });

  it('wakes on a matching lifecycle event and submits each scanned item', async () => {
    const scan = vi.fn(() => ['a', 'b']);
    const submit = vi.fn();
    runtime = startWorkerRuntime<string>({
      name: 'autofix',
      messageBus: bus,
      logger: makeLogger(),
      eventKinds: ['task.failed'],
      scan,
      submit,
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, failedEvent());
    await runtime.waitForIdle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, 'a');
    expect(submit).toHaveBeenNthCalledWith(2, 'b');
  });

  it('ignores lifecycle events whose kind is not in the filter', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'autofix',
      messageBus: bus,
      logger: makeLogger(),
      eventKinds: ['task.failed'],
      scan,
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, completedEvent());
    await runtime.waitForIdle();

    expect(scan).not.toHaveBeenCalled();
  });

  it('supports a custom event predicate', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'predicate',
      messageBus: bus,
      logger: makeLogger(),
      eventFilter: (event) => event.kind === 'workflow.wakeup',
      scan,
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, failedEvent());
    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, wakeupEvent());
    await runtime.waitForIdle();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('ignores non-lifecycle messages on the channel', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'test',
      messageBus: bus,
      logger: makeLogger(),
      scan,
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, { not: 'a lifecycle event' });
    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();
  });

  it('coalesces wakeups that arrive while a cycle is running into one extra cycle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scanCalls = 0;
    const scan = vi.fn(async () => {
      scanCalls += 1;
      if (scanCalls === 1) await gate;
      return [];
    });

    runtime = startWorkerRuntime({
      name: 'coalesce',
      messageBus: bus,
      logger: makeLogger(),
      scan,
      submit: vi.fn(),
      // Startup scan begins the first (blocked) cycle.
      registerSignalHandlers: false,
    });

    // The startup cycle is now parked on `gate`. Fire several wakeups; they must
    // collapse into exactly one follow-up cycle, not one cycle each.
    runtime.wake();
    runtime.wake();
    runtime.wake();

    release();
    await runtime.waitForIdle();

    expect(scanCalls).toBe(2);
  });

  it('polls on the configured interval so missed events still get reconciled', async () => {
    vi.useFakeTimers();
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'poller',
      messageBus: bus,
      logger: makeLogger(),
      scan,
      submit: vi.fn(),
      pollIntervalMs: 1_000,
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    expect(scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('stops cleanly: no more scans, drops the subscription, resolves waiters', async () => {
    const scan = vi.fn(() => []);
    runtime = startWorkerRuntime({
      name: 'stoppable',
      messageBus: bus,
      logger: makeLogger(),
      eventKinds: ['task.failed'],
      scan,
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    expect(runtime.isStopped()).toBe(false);

    const stoppedPromise = runtime.waitUntilStopped();
    runtime.stop();

    expect(runtime.isStopped()).toBe(true);
    await expect(stoppedPromise).resolves.toBeUndefined();

    // Events after stop are no longer observed.
    bus.publish(Channels.WORKFLOW_LIFECYCLE, failedEvent());
    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();

    // stop() is idempotent.
    expect(() => runtime!.stop()).not.toThrow();
  });

  it('registers SIGINT/SIGTERM handlers and removes them on stop', () => {
    const baselineInt = process.listenerCount('SIGINT');
    const baselineTerm = process.listenerCount('SIGTERM');

    runtime = startWorkerRuntime({
      name: 'signals',
      messageBus: bus,
      logger: makeLogger(),
      scan: vi.fn(() => []),
      submit: vi.fn(),
      runStartupScan: false,
      registerSignalHandlers: true,
    });

    expect(process.listenerCount('SIGINT')).toBe(baselineInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baselineTerm + 1);

    runtime.stop();

    expect(process.listenerCount('SIGINT')).toBe(baselineInt);
    expect(process.listenerCount('SIGTERM')).toBe(baselineTerm);
  });

  it('keeps running after a submit error and logs it', async () => {
    const logger = makeLogger();
    const submit = vi.fn((item: string) => {
      if (item === 'boom') throw new Error('submit failed');
    });
    runtime = startWorkerRuntime<string>({
      name: 'resilient',
      messageBus: bus,
      logger,
      scan: () => ['boom', 'ok'],
      submit,
      runStartupScan: false,
      registerSignalHandlers: false,
    });

    runtime.wake();
    await runtime.waitForIdle();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    expect(runtime.isStopped()).toBe(false);
  });
});
