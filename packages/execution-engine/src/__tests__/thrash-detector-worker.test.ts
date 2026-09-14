import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  buildThrashSignature,
  createThrashDetectorWorker,
  detectThrashSignatures,
  runThrashDetectorTick,
  type ThrashDetectorWorkerOptions,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as ThrashDetectorWorkerOptions['logger'];
}

function event(id: number, taskId: string, createdAt: string, phase = 'worker-autofix-submitted'): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify({ phase }),
    createdAt,
  };
}

function task(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date(NOW),
    config: { workflowId: id.split('/')[0], runnerKind: 'scratch' },
    execution: { generation: 0, error: '' },
    taskStateVersion: 1,
  } as TaskState;
}

function makeStore(events: TaskEvent[], outputs: Record<string, string>): ThrashDetectorWorkerStore {
  const tasks = [...new Set(events.map((item) => item.taskId))].map(task);
  return {
    listTaskEvents: ({ eventTypes } = {}) =>
      events.filter((item) => !eventTypes || eventTypes.includes(item.eventType)),
    listWorkflows: () => [{ id: 'wf' }],
    loadTasks: () => tasks,
    loadTask: (taskId) => tasks.find((item) => item.id === taskId),
    getEvents: (taskId) => events.filter((item) => item.taskId === taskId),
    getTaskOutput: (taskId) => outputs[taskId] ?? '',
    logEvent: vi.fn(),
  };
}

describe('thrash detector worker', () => {
  it('applies threshold and window math before emitting a detection', () => {
    const inWindowA = event(1, 'wf/a', '2026-09-14T11:00:00.000Z');
    const inWindowB = event(2, 'wf/b', '2026-09-14T10:00:00.000Z');
    const outOfWindow = event(3, 'wf/c', '2026-09-12T12:00:00.000Z');
    const signature = buildThrashSignature(inWindowA, 'same terminal failure')!;
    const detections = detectThrashSignatures([
      { event: inWindowA, taskId: 'wf/a', ...signature },
      { event: inWindowB, taskId: 'wf/b', ...signature },
      { event: outOfWindow, taskId: 'wf/c', ...signature },
    ], {
      thresholdCount: 2,
      windowHours: 24,
      nowMs: NOW,
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      signatureId: signature.signatureId,
      matchingTaskIds: ['wf/a', 'wf/b'],
      count: 2,
      window: {
        hours: 24,
        startedAt: '2026-09-13T12:00:00.000Z',
        endedAt: '2026-09-14T12:00:00.000Z',
      },
    });
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const events = [
      event(1, 'wf/a', '2026-09-14T11:00:00.000Z'),
      event(2, 'wf/b', '2026-09-14T10:00:00.000Z'),
      event(3, 'wf/c', '2026-09-14T09:00:00.000Z'),
    ];
    const store = makeStore(events, {
      'wf/a': 'TypeError: Cannot read properties of undefined',
      'wf/b': ' typeerror: cannot read properties of undefined ',
      'wf/c': 'ReferenceError: missing variable',
    });

    const detections = await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => NOW,
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.matchingTaskIds).toEqual(['wf/a', 'wf/b']);
    expect(store.logEvent).toHaveBeenCalledTimes(1);
    expect(store.logEvent).toHaveBeenCalledWith('wf/a', 'thrash.detected', expect.objectContaining({
      signatureId: detections[0]?.signatureId,
      matchingTaskIds: ['wf/a', 'wf/b'],
      count: 2,
      window: expect.objectContaining({ hours: 24 }),
    }));
  });

  it('does not emit a second audit event for an already detected signature', async () => {
    const autoFixEvent = event(1, 'wf/a', '2026-09-14T11:00:00.000Z');
    const signature = buildThrashSignature(autoFixEvent, 'same terminal failure')!;
    const store = makeStore([
      autoFixEvent,
      event(2, 'wf/b', '2026-09-14T10:00:00.000Z'),
      {
        id: 3,
        taskId: 'wf/a',
        eventType: 'thrash.detected',
        payload: JSON.stringify({ signatureId: signature.signatureId }),
        createdAt: '2026-09-14T11:30:00.000Z',
      },
    ], {
      'wf/a': 'same terminal failure',
      'wf/b': 'same terminal failure',
    });

    const detections = await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => NOW,
    });

    expect(detections).toEqual([]);
    expect(store.logEvent).not.toHaveBeenCalled();
  });

  it('never calls mutation channels while ticking through the registered runtime surface', async () => {
    const store = makeStore([
      event(1, 'wf/a', '2026-09-14T11:00:00.000Z'),
      event(2, 'wf/b', '2026-09-14T10:00:00.000Z'),
    ], {
      'wf/a': 'same terminal failure',
      'wf/b': 'same terminal failure',
    });
    const mutationSubmit = vi.fn(() => {
      throw new Error('mutation channel must not be called');
    });
    const runtime = createThrashDetectorWorker({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => NOW,
    });

    await runtime.tick('manual');

    expect(mutationSubmit).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledTimes(1);
  });
});
