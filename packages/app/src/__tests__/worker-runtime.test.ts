import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';

import { createWorkflowWakeupLifecycleEvent } from '../lifecycle-events.js';
import {
  startWorkerRuntime,
  type WorkerRuntime,
  type WorkerRuntimeContext,
} from '../worker-runtime.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const runtimeSourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../worker-runtime.ts');
const runtimes: WorkerRuntime[] = [];

function trackRuntime(runtime: WorkerRuntime): WorkerRuntime {
  runtimes.push(runtime);
  return runtime;
}

describe('worker runtime', () => {
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('wakes and submits scanned work from lifecycle events', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const scan = vi.fn(async () => ['intent-1']);
    const submit = vi.fn(async () => {});
    const runtime = trackRuntime(startWorkerRuntime({
      name: 'fake-worker',
      messageBus: bus,
      scan,
      submit,
      logger,
      intervalMs: 10_000,
      scanOnStart: false,
      installSignalHandlers: false,
    }));

    bus.publish(Channels.WORKFLOW_LIFECYCLE, createWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      reason: 'manual_reconcile',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    await runtime.whenIdle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      workerName: 'fake-worker',
      trigger: expect.objectContaining({ type: 'lifecycle' }),
    }));
    expect(submit).toHaveBeenCalledWith(
      'intent-1',
      expect.objectContaining({ workerName: 'fake-worker' }),
    );
    runtime.stop();
  });

  it('polls persisted state to recover missed lifecycle events', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const scan = vi.fn(async () => ['missed-intent']);
    const submit = vi.fn(async () => {});
    const runtime = trackRuntime(startWorkerRuntime({
      name: 'fake-worker',
      messageBus: bus,
      scan,
      submit,
      logger,
      intervalMs: 1_000,
      scanOnStart: false,
      installSignalHandlers: false,
    }));

    await vi.advanceTimersByTimeAsync(1_000);
    await runtime.whenIdle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toMatchObject({ trigger: { type: 'poll' } });
    expect(submit).toHaveBeenCalledWith(
      'missed-intent',
      expect.objectContaining({ trigger: expect.objectContaining({ type: 'poll' }) }),
    );
    runtime.stop();
  });

  it('stops cleanly on SIGTERM and ignores future wakeups and polls', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const scan = vi.fn(async () => ['intent-after-stop']);
    const submit = vi.fn(async () => {});
    const runtime = trackRuntime(startWorkerRuntime({
      name: 'fake-worker',
      messageBus: bus,
      scan,
      submit,
      logger,
      intervalMs: 1_000,
      scanOnStart: false,
    }));

    process.emit('SIGTERM');
    await runtime.stopped;
    bus.publish(Channels.WORKFLOW_LIFECYCLE, createWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      reason: 'manual_reconcile',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(scan).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not overlap scans and preserves one follow-up wakeup', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    let resolveFirstScan!: () => void;
    const firstScan = new Promise<readonly string[]>((resolve) => {
      resolveFirstScan = () => resolve(['first-intent']);
    });
    const scan = vi.fn()
      .mockReturnValueOnce(firstScan)
      .mockResolvedValueOnce(['second-intent']);
    const submit = vi.fn(async () => {});
    const runtime = trackRuntime(startWorkerRuntime({
      name: 'fake-worker',
      messageBus: bus,
      scan: (context: WorkerRuntimeContext) => scan(context),
      submit,
      logger,
      intervalMs: 10_000,
      scanOnStart: false,
      installSignalHandlers: false,
    }));

    runtime.requestScan({ type: 'poll' });
    runtime.requestScan({ type: 'poll' });
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);

    resolveFirstScan();
    await runtime.whenIdle();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith('first-intent', expect.any(Object));
    expect(submit).toHaveBeenCalledWith('second-intent', expect.any(Object));
    runtime.stop();
  });

  it('does not instantiate TaskRunner or import execution-engine', () => {
    const source = readFileSync(runtimeSourcePath, 'utf8');
    expect(source).not.toContain('TaskRunner');
    expect(source).not.toContain('@invoker/execution-engine');
  });
});
