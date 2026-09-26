import { describe, expect, it, vi } from 'vitest';

import {
  createThrashDetectorWorker,
  runThrashDetectorTick,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  type ThrashDetectorWorkerOptions,
} from '../workers/thrash-detector-worker.js';
import type { ThrashDetectorWorkerStore } from '../workers/thrash-detector-worker.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ThrashDetectorWorkerOptions['logger'];
}

function event(id: number, taskId: string, createdAt: string, phase = 'worker-autofix-submitted') {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify({ phase }),
    createdAt,
  };
}

function makeStore(events: ReturnType<typeof event>[], outputByTaskId: Record<string, string>): ThrashDetectorWorkerStore {
  return {
    listTaskEvents: vi.fn((filters) => {
      const eventTypes = new Set(filters?.eventTypes ?? []);
      return events
        .filter((row) => eventTypes.size === 0 || eventTypes.has(row.eventType))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .slice(0, filters?.limit ?? events.length);
    }),
    getTaskOutput: vi.fn((taskId) => outputByTaskId[taskId] ?? ''),
    logEvent: vi.fn(),
  };
}

describe('runThrashDetectorTick', () => {
  it('applies threshold and window math before logging one detection', async () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const store = makeStore([
      event(1, 'task-1', '2026-09-26T11:00:00.000Z'),
      event(2, 'task-2', '2026-09-26T10:30:00.000Z'),
      event(3, 'task-3', '2026-09-25T09:00:00.000Z'),
    ], {
      'task-1': 'TypeError: Cannot read properties of undefined',
      'task-2': 'TypeError: Cannot read properties of undefined',
      'task-3': 'TypeError: Cannot read properties of undefined',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      enabled: true,
      store,
      thresholdCount: 2,
      windowMs: 3 * 60 * 60 * 1000,
      now: () => now,
      classifyAutoFixRecoveryPhase: () => 'submit',
    });

    expect(store.logEvent).toHaveBeenCalledTimes(1);
    expect(store.logEvent).toHaveBeenCalledWith(
      'task-1',
      THRASH_DETECTED_EVENT_TYPE,
      expect.objectContaining({
        count: 2,
        matchingTaskIds: ['task-1', 'task-2'],
        window: expect.objectContaining({ hours: 3 }),
      }),
    );
  });

  it('groups the same signature across different task ids and keeps different signatures separate', async () => {
    const store = makeStore([
      event(1, 'task-a', '2026-09-26T11:00:00.000Z'),
      event(2, 'task-b', '2026-09-26T11:05:00.000Z'),
      event(3, 'task-c', '2026-09-26T11:10:00.000Z'),
    ], {
      'task-a': '/tmp/a/src/app.ts:17 TypeError: missing widget 123',
      'task-b': '/tmp/b/src/app.ts:41 TypeError: missing widget 456',
      'task-c': 'ReferenceError: missing config value',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      enabled: true,
      store,
      thresholdCount: 2,
      windowMs: 24 * 60 * 60 * 1000,
      now: () => Date.parse('2026-09-26T12:00:00.000Z'),
      classifyAutoFixRecoveryPhase: () => 'submit',
    });

    expect(store.logEvent).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(store.logEvent!).mock.calls[0]?.[2] as { matchingTaskIds?: string[] };
    expect(payload.matchingTaskIds).toEqual(['task-a', 'task-b']);
  });

  it('does not call any mutation channel', async () => {
    const store = makeStore([
      event(1, 'task-1', '2026-09-26T11:00:00.000Z'),
      event(2, 'task-2', '2026-09-26T11:05:00.000Z'),
    ], {
      'task-1': 'same failure',
      'task-2': 'same failure',
    });
    const submit = vi.fn();
    const approve = vi.fn();
    const recreateTask = vi.fn();

    await runThrashDetectorTick({
      logger: makeLogger(),
      enabled: true,
      store: { ...store, submit, approve, recreateTask } as never,
      thresholdCount: 2,
      windowMs: 24 * 60 * 60 * 1000,
      now: () => Date.parse('2026-09-26T12:00:00.000Z'),
      classifyAutoFixRecoveryPhase: () => 'submit',
    });

    expect(store.logEvent).toHaveBeenCalledWith(
      expect.any(String),
      THRASH_DETECTED_EVENT_TYPE,
      expect.any(Object),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(recreateTask).not.toHaveBeenCalled();
  });
});

describe('createThrashDetectorWorker', () => {
  it('uses the thrash-detector identity', () => {
    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store: {},
      onTick: async () => undefined,
      tickOnStart: false,
    });
    expect(worker.identity.kind).toBe(THRASH_DETECTOR_WORKER_KIND);
    worker.stop();
  });
});
