import { describe, expect, it, vi } from 'vitest';

import {
  runThrashDetectorTick,
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

function event(id: number, taskId: string, createdAt: string, phase: string, reason = 'same-failure') {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify({ phase, reason }),
    createdAt,
  };
}

function makeStore(tasks: Array<{ id: string; terminalOutputSnapshot?: string; events: ReturnType<typeof event>[] }>) {
  const logEvent = vi.fn();
  const store: ThrashDetectorStore = {
    listWorkflows: () => [{ id: 'wf-1' }],
    loadTasks: () => tasks.map((task) => ({
      id: task.id,
      terminalOutputSnapshot: task.terminalOutputSnapshot,
    })),
    getEvents: (taskId: string) => tasks.find((task) => task.id === taskId)?.events ?? [],
    logEvent,
  };
  return { store, logEvent };
}

describe('runThrashDetectorTick', () => {
  it('logs thrash.detected only after threshold matches inside the configured window', async () => {
    const { store, logEvent } = makeStore([
      {
        id: 'task-a',
        terminalOutputSnapshot: 'TypeError: cannot read property x',
        events: [
          event(1, 'task-a', '2026-09-12T09:00:00.000Z', 'worker-autofix-submitted'),
          event(2, 'task-a', '2026-09-10T09:00:00.000Z', 'worker-autofix-submitted'),
        ],
      },
      {
        id: 'task-b',
        terminalOutputSnapshot: 'TypeError: cannot read property x',
        events: [event(3, 'task-b', '2026-09-12T10:00:00.000Z', 'worker-autofix-submitted')],
      },
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-12T12:00:00.000Z'),
    });

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith('task-a', 'thrash.detected', expect.objectContaining({
      count: 2,
      matchingTaskIds: ['task-a', 'task-b'],
      window: {
        hours: 24,
        startedAt: '2026-09-11T12:00:00.000Z',
        endedAt: '2026-09-12T12:00:00.000Z',
      },
    }));
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const { store, logEvent } = makeStore([
      {
        id: 'task-a',
        terminalOutputSnapshot: 'SyntaxError: missing )',
        events: [event(1, 'task-a', '2026-09-12T09:00:00.000Z', 'worker-autofix-submitted')],
      },
      {
        id: 'task-b',
        terminalOutputSnapshot: 'SyntaxError: missing )',
        events: [event(2, 'task-b', '2026-09-12T10:00:00.000Z', 'worker-autofix-submitted')],
      },
      {
        id: 'task-c',
        terminalOutputSnapshot: 'ReferenceError: nope is not defined',
        events: [event(3, 'task-c', '2026-09-12T11:00:00.000Z', 'worker-autofix-submitted')],
      },
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-12T12:00:00.000Z'),
    });

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]?.[2]).toMatchObject({
      count: 2,
      matchingTaskIds: ['task-a', 'task-b'],
    });
  });

  it('does not require or call any mutation channel', async () => {
    const submitter = { submit: vi.fn() };
    const mutationChannel = { approve: vi.fn(), recreateTask: vi.fn(), fixWithAgent: vi.fn() };
    const { store, logEvent } = makeStore([
      {
        id: 'task-a',
        terminalOutputSnapshot: 'RangeError: maximum call stack size exceeded',
        events: [event(1, 'task-a', '2026-09-12T09:00:00.000Z', 'worker-autofix-submitted')],
      },
      {
        id: 'task-b',
        terminalOutputSnapshot: 'RangeError: maximum call stack size exceeded',
        events: [event(2, 'task-b', '2026-09-12T10:00:00.000Z', 'worker-autofix-submitted')],
      },
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-12T12:00:00.000Z'),
    });

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(mutationChannel.approve).not.toHaveBeenCalled();
    expect(mutationChannel.recreateTask).not.toHaveBeenCalled();
    expect(mutationChannel.fixWithAgent).not.toHaveBeenCalled();
    expect(THRASH_DETECTOR_WORKER_KIND).toBe('thrash-detector');
  });
});
