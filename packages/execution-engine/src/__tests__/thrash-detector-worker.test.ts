import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  registerThrashDetectorWorker,
  runThrashDetectorTick,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const now = new Date('2026-09-24T00:00:00.000Z');

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const classifyAutoFixRecoveryPhase = vi.fn(() => 'submit');

function event(id: number, taskId: string, createdAt: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify(payload),
    createdAt,
  };
}

function task(taskId: string, error = 'TypeError: shared failure at /tmp/worktree/src/index.ts:42'): TaskState {
  return {
    id: taskId,
    description: taskId,
    status: 'failed',
    dependencies: [],
    createdAt: now,
    config: { workflowId: 'wf-1' },
    execution: { error },
    taskStateVersion: 1,
  } as unknown as TaskState;
}

function makeStore(events: TaskEvent[], tasks: Record<string, TaskState>, output = 'same terminal failure'): {
  store: ThrashDetectorWorkerStore;
  logged: Array<{ taskId: string; eventType: string; payload: unknown }>;
} {
  const logged: Array<{ taskId: string; eventType: string; payload: unknown }> = [];
  return {
    logged,
    store: {
      listTaskEvents: ({ eventTypes } = {}) => events.filter((candidate) => (
        !eventTypes || eventTypes.includes(candidate.eventType)
      )),
      loadTask: (taskId) => tasks[taskId],
      getTaskOutput: () => output,
      logEvent: (taskId, eventType, payload) => {
        logged.push({ taskId, eventType, payload });
      },
    },
  };
}

describe('thrash detector worker', () => {
  it('applies threshold and window math before logging a detection', async () => {
    const { store, logged } = makeStore([
      event(1, 'task-1', '2026-09-23T23:55:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'same failure' }),
      event(2, 'task-2', '2026-09-23T23:50:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'same failure' }),
      event(3, 'task-3', '2026-09-22T23:59:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'same failure' }),
    ], {
      'task-1': task('task-1'),
      'task-2': task('task-2'),
      'task-3': task('task-3'),
    });

    await runThrashDetectorTick({
      thresholdCount: 3,
      windowHours: 24,
      logger,
      store,
      classifyAutoFixRecoveryPhase,
      now: () => now,
    });
    expect(logged).toEqual([]);

    await runThrashDetectorTick({
      thresholdCount: 2,
      windowHours: 24,
      logger,
      store,
      classifyAutoFixRecoveryPhase,
      now: () => now,
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const { store, logged } = makeStore([
      event(1, 'task-1', '2026-09-23T23:55:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'Error: alpha' }),
      event(2, 'task-2', '2026-09-23T23:50:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'Error: alpha' }),
      event(3, 'task-3', '2026-09-23T23:45:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'Error: beta' }),
    ], {
      'task-1': task('task-1', 'Error: alpha'),
      'task-2': task('task-2', 'Error: alpha'),
      'task-3': task('task-3', 'Error: beta'),
    });

    await runThrashDetectorTick({
      thresholdCount: 2,
      windowHours: 24,
      logger,
      store,
      classifyAutoFixRecoveryPhase,
      now: () => now,
    });

    expect(logged).toHaveLength(1);
    expect((logged[0]?.payload as { matchingTaskIds: string[] }).matchingTaskIds).toEqual(['task-1', 'task-2']);
    expect((logged[0]?.payload as { signatureId: string }).signatureId).toContain('alpha');
    expect((logged[0]?.payload as { signatureId: string }).signatureId).not.toContain('beta');
  });

  it('never calls a mutation submitter while scanning', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerThrashDetectorWorker(registry);
    const submit = vi.fn();
    const { store } = makeStore([
      event(1, 'task-1', '2026-09-23T23:55:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'same failure' }),
      event(2, 'task-2', '2026-09-23T23:50:00.000Z', { phase: 'auto-fix-route-failed', errorMessage: 'same failure' }),
    ], {
      'task-1': task('task-1'),
      'task-2': task('task-2'),
    });

    const worker = registry.get(THRASH_DETECTOR_WORKER_KIND)!.factory({
      store: {
        listWorkflows: () => [],
        loadTasks: () => [],
        listWorkflowMutationIntents: () => [],
        ...store,
      } as WorkerRuntimeDependencies['store'],
      submitter: { submit } as unknown as WorkerRuntimeDependencies['submitter'],
      logger,
      thrashDetector: {
        thresholdCount: 2,
        windowHours: 24,
        tickOnStart: false,
        classifyAutoFixRecoveryPhase,
        now: () => now,
      },
    });

    await worker.tick('manual');
    await worker.stop();

    expect(submit).not.toHaveBeenCalled();
  });
});
