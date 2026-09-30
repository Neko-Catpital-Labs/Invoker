import { describe, expect, it, vi } from 'vitest';

import type { TaskEvent } from '@invoker/data-store';

import {
  buildThrashFailureSignature,
  createThrashDetectorWorker,
  runThrashDetectorTick,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
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

function event(id: number, taskId: string, createdAt: string, phase = 'auto-fix-route-selected'): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    createdAt,
    payload: JSON.stringify({ phase, route: 'resume_from_fixed_tip' }),
  };
}

function makeStore(events: TaskEvent[], outputs: Record<string, string>): {
  store: ThrashDetectorStore & { submit?: unknown; approve?: unknown; recreateTask?: unknown };
  logged: Array<{ taskId: string; eventType: string; payload: unknown }>;
} {
  const logged: Array<{ taskId: string; eventType: string; payload: unknown }> = [];
  return {
    logged,
    store: {
      submit: vi.fn(),
      approve: vi.fn(),
      recreateTask: vi.fn(),
      listTaskEvents: ({ eventTypes = [], sortBy = 'desc' } = {}) => events
        .filter((candidate) => eventTypes.includes(candidate.eventType))
        .sort((a, b) => sortBy === 'asc' ? a.id - b.id : b.id - a.id),
      getTaskOutput: (taskId) => outputs[taskId] ?? '',
      logEvent: (taskId, eventType, payload) => {
        logged.push({ taskId, eventType, payload });
      },
    },
  };
}

describe('buildThrashFailureSignature', () => {
  it('groups the same normalized signature across different task ids and separates different terminal output', () => {
    const first = buildThrashFailureSignature(
      event(1, 'wf-a/task-a', '2026-09-30T00:00:00.000Z'),
      'Error: TypeError at 2026-09-30T00:00:00.000Z\nsha abcdef1234567890',
    );
    const same = buildThrashFailureSignature(
      event(2, 'wf-b/task-b', '2026-09-30T00:01:00.000Z'),
      'Error: TypeError at 2026-09-30T01:02:03.000Z\nsha 123456abcdef7890',
    );
    const different = buildThrashFailureSignature(
      event(3, 'wf-c/task-c', '2026-09-30T00:02:00.000Z'),
      'Error: SyntaxError in config parser',
    );

    expect(same.signatureId).toBe(first.signatureId);
    expect(different.signatureId).not.toBe(first.signatureId);
  });
});

describe('runThrashDetectorTick', () => {
  it('logs one thrash.detected event when threshold is met inside the window', async () => {
    const now = new Date('2026-09-30T12:00:00.000Z');
    const { store, logged } = makeStore([
      event(1, 'wf-a/task-a', '2026-09-30T11:00:00.000Z'),
      event(2, 'wf-b/task-b', '2026-09-30T11:10:00.000Z'),
      event(3, 'wf-c/task-c', '2026-09-30T11:20:00.000Z'),
      event(4, 'wf-old/task-old', '2026-09-28T11:20:00.000Z'),
    ], {
      'wf-a/task-a': 'Error: TypeError at 2026-09-30T11:00:00.000Z',
      'wf-b/task-b': 'Error: TypeError at 2026-09-30T11:10:00.000Z',
      'wf-c/task-c': 'Error: TypeError at 2026-09-30T11:20:00.000Z',
      'wf-old/task-old': 'Error: TypeError at 2026-09-28T11:20:00.000Z',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 2,
      now: () => now,
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      eventType: THRASH_DETECTED_EVENT_TYPE,
      taskId: 'wf-a/task-a',
    });
    expect(logged[0]?.payload).toMatchObject({
      kind: THRASH_DETECTOR_WORKER_KIND,
      taskIds: ['wf-a/task-a', 'wf-b/task-b', 'wf-c/task-c'],
      count: 3,
      thresholdCount: 3,
      window: {
        hours: 2,
        startedAt: '2026-09-30T10:00:00.000Z',
        endedAt: '2026-09-30T12:00:00.000Z',
      },
    });
  });

  it('does not group different signatures together', async () => {
    const { store, logged } = makeStore([
      event(1, 'wf-a/task-a', '2026-09-30T11:00:00.000Z'),
      event(2, 'wf-b/task-b', '2026-09-30T11:10:00.000Z'),
      event(3, 'wf-c/task-c', '2026-09-30T11:20:00.000Z'),
    ], {
      'wf-a/task-a': 'Error: TypeError',
      'wf-b/task-b': 'Error: TypeError',
      'wf-c/task-c': 'Error: SyntaxError',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(logged).toEqual([]);
  });

  it('never calls mutation channel seams', async () => {
    const { store } = makeStore([
      event(1, 'wf-a/task-a', '2026-09-30T11:00:00.000Z'),
      event(2, 'wf-b/task-b', '2026-09-30T11:10:00.000Z'),
      event(3, 'wf-c/task-c', '2026-09-30T11:20:00.000Z'),
    ], {
      'wf-a/task-a': 'Error: TypeError',
      'wf-b/task-b': 'Error: TypeError',
      'wf-c/task-c': 'Error: TypeError',
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 24,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(store.submit).not.toHaveBeenCalled();
    expect(store.approve).not.toHaveBeenCalled();
    expect(store.recreateTask).not.toHaveBeenCalled();
  });
});

describe('createThrashDetectorWorker', () => {
  it('uses the default worker identity and interval', () => {
    const { store } = makeStore([], {});
    const worker = createThrashDetectorWorker({
      logger: makeLogger(),
      store,
      tickOnStart: false,
      onTick: async () => undefined,
    });
    expect(worker.identity.kind).toBe(THRASH_DETECTOR_WORKER_KIND);
    worker.stop();
  });
});
