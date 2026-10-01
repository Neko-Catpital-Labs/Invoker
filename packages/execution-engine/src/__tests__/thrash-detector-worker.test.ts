import { describe, expect, it, vi } from 'vitest';

import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  buildThrashSignature,
  registerThrashDetectorWorker,
  runThrashDetectorTick,
  type ThrashDetectorStore,
  type ThrashDetectorWorkerOptions,
} from '../workers/thrash-detector-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as ThrashDetectorWorkerOptions['logger'];
}

function task(id: string, error: string): TaskState {
  const workflowId = id.split('/')[0] ?? 'wf';
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    config: { id, workflowId },
    execution: { error },
    taskStateVersion: 1,
  } as unknown as TaskState;
}

function event(
  id: number,
  taskId: string,
  createdAt: string,
  payload: Record<string, unknown>,
  eventType = 'debug.auto-fix',
): TaskEvent {
  return {
    id,
    taskId,
    eventType,
    payload: JSON.stringify(payload),
    createdAt,
  };
}

function makeStore(input: { tasks: TaskState[]; events: TaskEvent[] }): {
  store: ThrashDetectorStore;
  logged: Array<{ taskId: string; eventType: string; payload?: unknown }>;
} {
  const logged: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  return {
    logged,
    store: {
      listWorkflows: () => [{ id: 'wf' }],
      loadTasks: () => input.tasks,
      loadTask: (taskId) => input.tasks.find((candidate) => candidate.id === taskId),
      listTaskEvents: (filters) => input.events
        .filter((candidate) => !filters?.eventTypes || filters.eventTypes.includes(candidate.eventType))
        .sort((a, b) => a.id - b.id),
      logEvent: (taskId, eventType, payload) => {
        logged.push({ taskId, eventType, payload });
      },
    },
  };
}

describe('runThrashDetectorTick', () => {
  it('logs once when a signature reaches the threshold inside the window', async () => {
    const tasks = [
      task('wf/t1', 'pnpm test failed with exit code 1'),
      task('wf/t2', 'pnpm test failed with exit code 2'),
      task('wf/t3', 'pnpm test failed with exit code 3'),
      task('wf/old', 'pnpm test failed with exit code 4'),
    ];
    const { store, logged } = makeStore({
      tasks,
      events: [
        event(1, 'wf/old', '2026-09-29T23:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'wf/t1', '2026-09-30T23:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(3, 'wf/t2', '2026-09-30T23:30:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(4, 'wf/t3', '2026-10-01T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      ],
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 3,
      windowHours: 1,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(logged[0]?.taskId).toBe('wf/t3');
    expect(logged[0]?.payload).toMatchObject({
      kind: THRASH_DETECTOR_WORKER_KIND,
      matchingTaskIds: ['wf/t1', 'wf/t2', 'wf/t3'],
      count: 3,
      window: {
        hours: 1,
        startedAt: '2026-09-30T23:00:00.000Z',
        endedAt: '2026-10-01T00:00:00.000Z',
      },
    });
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const tasks = [
      task('wf/a', 'TypeError: Cannot read properties of undefined'),
      task('wf/b', 'TypeError: Cannot read properties of undefined'),
      task('wf/c', 'ReferenceError: missingSymbol is not defined'),
    ];
    const { store, logged } = makeStore({
      tasks,
      events: [
        event(1, 'wf/a', '2026-10-01T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'wf/b', '2026-10-01T00:01:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(3, 'wf/c', '2026-10-01T00:02:00.000Z', { phase: 'worker-autofix-submitted' }),
      ],
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 1,
      now: () => new Date('2026-10-01T00:03:00.000Z'),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.payload).toMatchObject({
      matchingTaskIds: ['wf/a', 'wf/b'],
      count: 2,
    });

    const sameA = buildThrashSignature({ phase: 'worker-autofix-submitted', payload: {}, task: tasks[0] });
    const sameB = buildThrashSignature({ phase: 'worker-autofix-submitted', payload: {}, task: tasks[1] });
    const different = buildThrashSignature({ phase: 'worker-autofix-submitted', payload: {}, task: tasks[2] });
    expect(sameA.signatureId).toBe(sameB.signatureId);
    expect(sameA.signatureId).not.toBe(different.signatureId);
  });

  it('does not call mutation channels when registered through runtime dependencies', async () => {
    const tasks = [
      task('wf/t1', 'same failure'),
      task('wf/t2', 'same failure'),
    ];
    const { store, logged } = makeStore({
      tasks,
      events: [
        event(1, 'wf/t1', '2026-10-01T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'wf/t2', '2026-10-01T00:01:00.000Z', { phase: 'worker-autofix-submitted' }),
      ],
    });
    const submit = vi.fn();
    const registry = registerThrashDetectorWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const worker = registry.get(THRASH_DETECTOR_WORKER_KIND)?.factory({
      store,
      submitter: { submit } as never,
      logger: makeLogger(),
      thrashDetector: {
        thresholdCount: 2,
        windowHours: 1,
        now: () => new Date('2026-10-01T00:02:00.000Z'),
        tickOnStart: false,
      },
    } as WorkerRuntimeDependencies);

    expect(worker).toBeDefined();
    await worker!.tick('manual');
    await worker!.stop();

    expect(logged).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not log a duplicate thrash.detected event for a signature already emitted in the window', async () => {
    const tasks = [
      task('wf/t1', 'same failure'),
      task('wf/t2', 'same failure'),
    ];
    const signature = buildThrashSignature({
      phase: 'worker-autofix-submitted',
      payload: {},
      task: tasks[0],
    });
    const { store, logged } = makeStore({
      tasks,
      events: [
        event(1, 'wf/t1', '2026-10-01T00:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'wf/t2', '2026-10-01T00:01:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(3, 'wf/t2', '2026-10-01T00:01:30.000Z', { signatureId: signature.signatureId }, THRASH_DETECTED_EVENT_TYPE),
      ],
    });

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 1,
      now: () => new Date('2026-10-01T00:02:00.000Z'),
    });

    expect(logged).toEqual([]);
  });
});
