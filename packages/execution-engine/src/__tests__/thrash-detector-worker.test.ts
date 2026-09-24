import { describe, expect, it, vi } from 'vitest';

import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  createThrashDetectorWorker,
  runThrashDetectorTick,
  type ThrashDetectorStore,
  type ThrashDetectorWorkerOptions,
} from '../workers/thrash-detector-worker.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ThrashDetectorWorkerOptions['logger'];
}

function task(id: string, error: string): TaskState {
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {},
    execution: { error },
    taskStateVersion: 1,
  } as TaskState;
}

function event(id: number, taskId: string, createdAt: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify(payload),
    createdAt,
  };
}

function makeStore(events: TaskEvent[], tasks: TaskState[]): {
  store: ThrashDetectorStore;
  logged: Array<{ taskId: string; eventType: string; payload: unknown }>;
  mutationChannel: ReturnType<typeof vi.fn>;
} {
  const taskById = new Map(tasks.map((entry) => [entry.id, entry]));
  const logged: Array<{ taskId: string; eventType: string; payload: unknown }> = [];
  const mutationChannel = vi.fn();
  return {
    logged,
    mutationChannel,
    store: {
      getEventsByTypes: (eventTypes) => events.filter((entry) => eventTypes.includes(entry.eventType)),
      loadTask: (taskId) => taskById.get(taskId),
      logEvent: (taskId, eventType, payload) => {
        logged.push({ taskId, eventType, payload });
      },
      ...({ submit: mutationChannel, approve: mutationChannel, recreateTask: mutationChannel } as object),
    },
  };
}

describe('runThrashDetectorTick', () => {
  it('logs one thrash.detected event when the threshold is reached within the window', async () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const { store, logged } = makeStore([
      event(1, 'task-a', '2026-01-01T23:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(2, 'task-b', '2026-01-01T22:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(3, 'task-c', '2026-01-01T21:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(4, 'task-d', '2025-12-31T23:00:00.000Z', { phase: 'worker-autofix-submitted' }),
    ], [
      task('task-a', 'TypeError: cannot read property x'),
      task('task-b', 'TypeError: cannot read property x'),
      task('task-c', 'TypeError: cannot read property x'),
      task('task-d', 'TypeError: cannot read property x'),
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      now: () => now,
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(logged[0]?.payload).toMatchObject({
      matchingTaskIds: ['task-a', 'task-b', 'task-c'],
      count: 3,
      window: {
        hours: 24,
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-02T00:00:00.000Z',
      },
    });
  });

  it('groups the same signature across task ids and does not group different signatures', async () => {
    const { store, logged } = makeStore([
      event(1, 'task-a', '2026-01-02T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(2, 'task-b', '2026-01-02T00:01:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(3, 'task-c', '2026-01-02T00:02:00.000Z', { phase: 'worker-autofix-submitted' }),
    ], [
      task('task-a', 'ReferenceError: shared failure'),
      task('task-b', 'ReferenceError: shared failure'),
      task('task-c', 'SyntaxError: separate failure'),
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 1,
      now: () => new Date('2026-01-02T00:30:00.000Z'),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.payload).toMatchObject({
      matchingTaskIds: ['task-a', 'task-b'],
      count: 2,
    });
  });

  it('never calls mutation channels while detecting recurrence', async () => {
    const { store, logged, mutationChannel } = makeStore([
      event(1, 'task-a', '2026-01-02T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(2, 'task-b', '2026-01-02T00:01:00.000Z', { phase: 'worker-autofix-submitted' }),
    ], [
      task('task-a', 'Error: recurring failure'),
      task('task-b', 'Error: recurring failure'),
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 1,
      now: () => new Date('2026-01-02T00:30:00.000Z'),
    });

    expect(logged).toHaveLength(1);
    expect(mutationChannel).not.toHaveBeenCalled();
  });
});

describe('createThrashDetectorWorker', () => {
  it('uses the default fifteen-minute interval', () => {
    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store: makeStore([], []).store,
      onTick: async () => undefined,
      tickOnStart: false,
    });
    expect(worker.identity.kind).toBe(THRASH_DETECTOR_WORKER_KIND);
    expect(DEFAULT_THRASH_DETECTOR_INTERVAL_MS).toBe(15 * 60_000);
    worker.stop();
  });
});
