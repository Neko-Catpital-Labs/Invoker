import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@invoker/data-store';

import {
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  THRASH_SOURCE_EVENT_TYPE,
  createThrashDetectorWorker,
  normalizeThrashFailureText,
  planThrashDetections,
  registerThrashDetectorWorker,
  runThrashDetectorTick,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const nowMs = Date.parse('2026-09-13T12:00:00.000Z');

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function event(id: number, taskId: string, createdAt: string, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id,
    taskId,
    eventType: THRASH_SOURCE_EVENT_TYPE,
    createdAt,
    payload: JSON.stringify(payload),
  };
}

function createStore(options: {
  events: TaskEvent[];
  existingDetections?: TaskEvent[];
  outputs: Record<string, string>;
}): ThrashDetectorWorkerStore & { logEvent: ReturnType<typeof vi.fn> } {
  const logEvent = vi.fn();
  return {
    listTaskEvents: (filters) => {
      if (filters?.eventTypes?.includes(THRASH_DETECTED_EVENT_TYPE)) {
        return options.existingDetections ?? [];
      }
      return options.events;
    },
    getTaskOutput: (taskId) => options.outputs[taskId] ?? '',
    logEvent,
  };
}

describe('thrash-detector worker', () => {
  it('applies threshold and window math before emitting a detection', async () => {
    const store = createStore({
      events: [
        event(1, 'task-a', '2026-09-13T11:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'task-b', '2026-09-13T10:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(3, 'task-old', '2026-09-11T10:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      ],
      outputs: {
        'task-a': 'Error: pnpm test failed at /tmp/worktrees/a\nExpected 1 to equal 2',
        'task-b': 'Error: pnpm test failed at /tmp/worktrees/b\nExpected 1 to equal 2',
        'task-old': 'Error: pnpm test failed at /tmp/worktrees/old\nExpected 1 to equal 2',
      },
    });

    await runThrashDetectorTick({
      logger,
      store,
      thresholdCount: 3,
      windowMs: 24 * 60 * 60_000,
      now: () => nowMs,
      classifyAutoFixRecoveryPhase: () => 'submit',
    });
    expect(store.logEvent).not.toHaveBeenCalled();

    await runThrashDetectorTick({
      logger,
      store,
      thresholdCount: 2,
      windowMs: 24 * 60 * 60_000,
      now: () => nowMs,
      classifyAutoFixRecoveryPhase: () => 'submit',
    });
    expect(store.logEvent).toHaveBeenCalledTimes(1);
    expect(store.logEvent).toHaveBeenCalledWith(
      'task-a',
      THRASH_DETECTED_EVENT_TYPE,
      expect.objectContaining({
        count: 2,
        matchingTaskIds: ['task-a', 'task-b'],
        window: expect.objectContaining({
          startsAt: '2026-09-12T12:00:00.000Z',
          endsAt: '2026-09-13T12:00:00.000Z',
        }),
      }),
    );
  });

  it('groups matching normalized signatures across task ids and keeps different signatures separate', () => {
    const events = [
      event(1, 'task-a', '2026-09-13T11:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(2, 'task-b', '2026-09-13T10:00:00.000Z', { phase: 'schedule-enqueued' }),
      event(3, 'task-c', '2026-09-13T09:00:00.000Z', { phase: 'worker-autofix-submitted' }),
    ];
    const outputs: Record<string, string> = {
      'task-a': 'fatal: cannot apply patch in /tmp/worktrees/a at abc1234',
      'task-b': 'fatal: cannot apply patch in /tmp/worktrees/b at def5678',
      'task-c': 'TypeError: missing required field',
    };

    const detections = planThrashDetections({
      events,
      existingDetections: [],
      getTaskOutput: (taskId) => outputs[taskId] ?? '',
      classifyAutoFixRecoveryPhase: () => 'submit',
      thresholdCount: 2,
      windowMs: 24 * 60 * 60_000,
      nowMs,
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      count: 2,
      matchingTaskIds: ['task-a', 'task-b'],
    });
    expect(normalizeThrashFailureText(outputs['task-a'])).toBe(normalizeThrashFailureText(outputs['task-b']));
    expect(normalizeThrashFailureText(outputs['task-a'])).not.toBe(normalizeThrashFailureText(outputs['task-c']));
  });

  it('does not emit a second audit event for a signature that was already detected', async () => {
    const sourceEvents = [
      event(1, 'task-a', '2026-09-13T11:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      event(2, 'task-b', '2026-09-13T10:00:00.000Z', { phase: 'worker-autofix-submitted' }),
    ];
    const outputs = {
      'task-a': 'same terminal failure',
      'task-b': 'same terminal failure',
    };
    const [first] = planThrashDetections({
      events: sourceEvents,
      existingDetections: [],
      getTaskOutput: (taskId) => outputs[taskId as keyof typeof outputs],
      classifyAutoFixRecoveryPhase: () => 'submit',
      thresholdCount: 2,
      windowMs: 24 * 60 * 60_000,
      nowMs,
    });
    const store = createStore({
      events: sourceEvents,
      existingDetections: [{
        id: 3,
        taskId: 'task-a',
        eventType: THRASH_DETECTED_EVENT_TYPE,
        createdAt: '2026-09-13T11:30:00.000Z',
        payload: JSON.stringify({ signatureId: first.signatureId }),
      }],
      outputs,
    });

    await runThrashDetectorTick({
      logger,
      store,
      thresholdCount: 2,
      windowMs: 24 * 60 * 60_000,
      now: () => nowMs,
      classifyAutoFixRecoveryPhase: () => 'submit',
    });

    expect(store.logEvent).not.toHaveBeenCalled();
  });

  it('builds without calling task or workflow action channels', async () => {
    const submit = vi.fn();
    const approveTask = vi.fn();
    const rejectTask = vi.fn();
    const recreateTask = vi.fn();
    const store = createStore({
      events: [
        event(1, 'task-a', '2026-09-13T11:00:00.000Z', { phase: 'worker-autofix-submitted' }),
        event(2, 'task-b', '2026-09-13T10:00:00.000Z', { phase: 'worker-autofix-submitted' }),
      ],
      outputs: {
        'task-a': 'same terminal failure',
        'task-b': 'same terminal failure',
      },
    });
    const registry = registerThrashDetectorWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const runtime = registry.get(THRASH_DETECTOR_WORKER_KIND)!.factory({
      store: {
        ...store,
        approveTask,
        rejectTask,
        recreateTask,
      } as never,
      submitter: { submit },
      logger,
      thrashDetector: {
        thresholdCount: 2,
        windowMs: 24 * 60 * 60_000,
        now: () => nowMs,
        tickOnStart: false,
        classifyAutoFixRecoveryPhase: () => 'submit',
      },
    });

    await runtime.tick('manual');

    expect(store.logEvent).toHaveBeenCalledWith(
      'task-a',
      THRASH_DETECTED_EVENT_TYPE,
      expect.objectContaining({ count: 2 }),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(approveTask).not.toHaveBeenCalled();
    expect(rejectTask).not.toHaveBeenCalled();
    expect(recreateTask).not.toHaveBeenCalled();
  });

  it('creates a stopped runtime with the configured identity', () => {
    const runtime = createThrashDetectorWorker({
      logger,
      store: createStore({ events: [], outputs: {} }),
      tickOnStart: false,
    });
    expect(runtime.identity.kind).toBe(THRASH_DETECTOR_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
  });
});
