import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';
import {
  buildTaskUpdatedLifecycleEvent,
  type WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import {
  startWorkerRuntime,
  type WorkerRuntimeSignalTarget,
} from '../worker-runtime.js';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function lifecycleEvent(status: 'completed' | 'failed'): WorkflowLifecycleEvent {
  return buildTaskUpdatedLifecycleEvent({
    workflowId: 'wf-1',
    taskId: 'wf-1/task-a',
    status,
    previousStatus: 'running',
    taskStateVersion: status === 'failed' ? 3 : 2,
    generation: 1,
    createdAt: CREATED_AT,
  });
}

describe('worker-runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('wakes immediately for relevant workflow lifecycle events', async () => {
    const bus = new LocalBus();
    const scan = vi.fn(async () => ['candidate-1']);
    const submit = vi.fn(async () => {});
    const runtime = startWorkerRuntime<string>({
      name: 'fake-worker',
      messageBus: bus,
      logger,
      scan,
      submit,
      pollIntervalMs: 0,
      startImmediately: false,
      signalNames: [],
      relevantLifecycleEvents: ['task.failed'],
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('completed'));
    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('failed'));
    await runtime.waitForIdle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toMatchObject({
      workerName: 'fake-worker',
      trigger: {
        kind: 'lifecycle',
        event: expect.objectContaining({ kind: 'task.failed', taskId: 'wf-1/task-a' }),
      },
    });
    expect(submit).toHaveBeenCalledWith(
      'candidate-1',
      expect.objectContaining({
        workerName: 'fake-worker',
        candidate: 'candidate-1',
        trigger: expect.objectContaining({ kind: 'lifecycle' }),
      }),
    );

    await runtime.stop();
  });

  it('polls scan callbacks so workers can recover missed events from persisted state', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const scan = vi.fn(async () => ['candidate-from-poll']);
    const submit = vi.fn(async () => {});
    const runtime = startWorkerRuntime<string>({
      name: 'fake-worker',
      messageBus: bus,
      logger,
      scan,
      submit,
      pollIntervalMs: 1000,
      startImmediately: false,
      signalNames: [],
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await runtime.waitForIdle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toMatchObject({
      workerName: 'fake-worker',
      trigger: { kind: 'poll' },
    });
    expect(submit).toHaveBeenCalledWith(
      'candidate-from-poll',
      expect.objectContaining({
        candidate: 'candidate-from-poll',
        trigger: expect.objectContaining({ kind: 'poll' }),
      }),
    );

    await runtime.stop();
  });

  it('shuts down cleanly on SIGTERM and unsubscribes from future wakeups', async () => {
    const bus = new LocalBus();
    const signalTarget = new EventEmitter();
    const scan = vi.fn(async () => ['candidate']);
    const runtime = startWorkerRuntime<string>({
      name: 'fake-worker',
      messageBus: bus,
      logger,
      scan,
      submit: vi.fn(async () => {}),
      pollIntervalMs: 1000,
      startImmediately: false,
      signalTarget: signalTarget as unknown as WorkerRuntimeSignalTarget,
      signalNames: ['SIGTERM'],
    });

    const stopped = runtime.waitUntilStopped();
    signalTarget.emit('SIGTERM');
    await stopped;

    expect(runtime.isStopped()).toBe(true);
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0);

    bus.publish(Channels.WORKFLOW_LIFECYCLE, lifecycleEvent('failed'));
    await runtime.waitForIdle();
    expect(scan).not.toHaveBeenCalled();
  });

  it('keeps task execution and scheduler ownership out of the runtime source', () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker-runtime.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(/\bTaskRunner\b/);
    expect(source).not.toMatch(/\bexecuteTasks\b/);
    expect(source).not.toMatch(/\bLaunchDispatcher\b/);
  });
});
