import { describe, expect, it, vi } from 'vitest';

import {
  THRASH_DETECTED_EVENT_TYPE,
  buildThrashFailureSignature,
  createThrashDetectorWorker,
  runThrashDetectorTick,
  type ThrashDetectorStore,
  type ThrashDetectorWorkerOptions,
} from '../workers/thrash-detector-worker.js';
import type { TaskEvent } from '@invoker/data-store';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { registerThrashDetectorWorker } from '../workers/thrash-detector-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';

function makeLogger(): ThrashDetectorWorkerOptions['logger'] {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ThrashDetectorWorkerOptions['logger'];
}

function event(id: number, taskId: string, createdAt: string, phase: string, reason: string): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify({ phase, reason }),
    createdAt,
  };
}

function makeStore(events: TaskEvent[], taskErrors: Record<string, string> = {}): ThrashDetectorStore & {
  writes: Array<{ taskId: string; eventType: string; payload: unknown }>;
} {
  const writes: Array<{ taskId: string; eventType: string; payload: unknown }> = [];
  return {
    writes,
    listTaskEvents: vi.fn(({ eventTypes }: { eventTypes?: readonly string[] } = {}) =>
      events.filter((candidate) => !eventTypes || eventTypes.includes(candidate.eventType))),
    loadTask: vi.fn((taskId: string) => ({ id: taskId, execution: { error: taskErrors[taskId] } })),
    logEvent: vi.fn((taskId, eventType, payload) => {
      writes.push({ taskId, eventType, payload });
    }),
  };
}

describe('thrash detector worker', () => {
  it('applies threshold and window math before logging thrash.detected', async () => {
    const store = makeStore([
      event(1, 'task-a', '2026-09-14T09:30:00.000Z', 'worker-autofix-skip', 'same failure'),
      event(2, 'task-b', '2026-09-14T09:45:00.000Z', 'worker-autofix-skip', 'same failure'),
      event(3, 'task-c', '2026-09-14T08:59:00.000Z', 'worker-autofix-skip', 'same failure'),
    ], {
      'task-a': 'ERR_SHARED failure',
      'task-b': 'ERR_SHARED failure',
      'task-c': 'ERR_SHARED failure',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 1,
      now: new Date('2026-09-14T10:00:00.000Z'),
    });

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(store.writes[0]?.payload).toMatchObject({
      taskIds: ['task-a', 'task-b'],
      count: 2,
      window: {
        hours: 1,
        start: '2026-09-14T09:00:00.000Z',
        end: '2026-09-14T10:00:00.000Z',
      },
    });
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const store = makeStore([
      event(1, 'task-a', '2026-09-14T09:10:00.000Z', 'worker-autofix-skip', 'same'),
      event(2, 'task-b', '2026-09-14T09:20:00.000Z', 'worker-autofix-skip', 'same'),
      event(3, 'task-c', '2026-09-14T09:30:00.000Z', 'worker-autofix-skip', 'different'),
      event(4, 'task-d', '2026-09-14T09:40:00.000Z', 'worker-autofix-skip', 'different'),
    ], {
      'task-a': 'TypeError cannot read property owner',
      'task-b': 'TypeError cannot read property owner',
      'task-c': 'ReferenceError missing config',
      'task-d': 'ReferenceError missing config',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: new Date('2026-09-14T10:00:00.000Z'),
    });

    expect(store.writes).toHaveLength(2);
    const taskGroups = store.writes.map((write) => (write.payload as { taskIds: string[] }).taskIds);
    expect(taskGroups).toContainEqual(['task-a', 'task-b']);
    expect(taskGroups).toContainEqual(['task-c', 'task-d']);
  });

  it('does not call mutation channels when registered through runtime dependencies', async () => {
    const registry = registerThrashDetectorWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get('thrash-detector');
    const submitter = new Proxy({}, {
      get() {
        throw new Error('mutation channel was touched');
      },
    });
    const store = makeStore([
      event(1, 'task-a', '2026-09-14T09:10:00.000Z', 'worker-autofix-skip', 'same'),
      event(2, 'task-b', '2026-09-14T09:20:00.000Z', 'worker-autofix-skip', 'same'),
    ], {
      'task-a': 'same terminal failure',
      'task-b': 'same terminal failure',
    });

    const worker = definition.factory({
      store,
      submitter,
      logger: makeLogger(),
      thrashDetector: {
        thresholdCount: 2,
        windowHours: 24,
        onTick: async () => runThrashDetectorTick({
          logger: makeLogger(),
          store,
          thresholdCount: 2,
          windowHours: 24,
          now: new Date('2026-09-14T10:00:00.000Z'),
        }),
      },
    } as unknown as WorkerRuntimeDependencies);

    await worker.tick('test');

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
  });

  it('builds stable signature ids from classifier phase and terminal text', () => {
    const first = buildThrashFailureSignature(
      event(1, 'task-a', '2026-09-14T09:10:00.000Z', 'worker-autofix-skip', 'same'),
      'TypeError: Cannot read property owner',
    );
    const second = buildThrashFailureSignature(
      event(2, 'task-b', '2026-09-14T09:20:00.000Z', 'worker-autofix-skip', 'same'),
      'TypeError: Cannot read property owner',
    );

    expect(first?.signatureId).toBe(second?.signatureId);
  });

  it('creates a runtime with the default tick', () => {
    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store: makeStore([]),
      tickOnStart: false,
    });

    expect(worker.identity.kind).toBe('thrash-detector');
  });
});
