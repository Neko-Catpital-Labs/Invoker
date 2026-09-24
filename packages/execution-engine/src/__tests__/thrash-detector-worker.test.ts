import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { TaskEvent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import {
  collectThrashDetections,
  registerThrashDetectorWorker,
  runThrashDetectorTick,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
} from '../workers/thrash-detector-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function task(id: string, output: string): TaskState {
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: id.split('/')[0] },
    execution: { generation: 1, error: output },
    taskStateVersion: 1,
  } as TaskState;
}

function event(
  id: number,
  taskId: string,
  createdAt: string,
  phase = 'worker-autofix-submitted',
): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    createdAt,
    payload: JSON.stringify({ phase, status: 'failed' }),
  };
}

function makeStore(args: {
  tasks: TaskState[];
  events: TaskEvent[];
  detected?: TaskEvent[];
  outputByTaskId?: Record<string, string>;
}) {
  const tasks = new Map(args.tasks.map((entry) => [entry.id, entry]));
  const logged: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store = {
    listWorkflows: vi.fn(() => Array.from(new Set(args.tasks.map((entry) => entry.config.workflowId)))
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id }))),
    loadTasks: vi.fn((workflowId: string) => args.tasks.filter((entry) => entry.config.workflowId === workflowId)),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    getTaskOutput: vi.fn((taskId: string) => args.outputByTaskId?.[taskId] ?? tasks.get(taskId)?.execution.error ?? ''),
    listTaskEvents: vi.fn((filters?: { eventTypes?: readonly string[]; sortBy?: 'asc' | 'desc' }) => {
      const all = [...args.events, ...(args.detected ?? [])];
      const filtered = filters?.eventTypes
        ? all.filter((entry) => filters.eventTypes?.includes(entry.eventType))
        : all;
      return filtered.sort((a, b) => filters?.sortBy === 'asc' ? a.id - b.id : b.id - a.id);
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      logged.push({ taskId, eventType, payload });
    }),
  };
  return { store, logged };
}

describe('thrash-detector worker', () => {
  it('applies threshold and window math over distinct matching task ids', () => {
    const shared = 'TypeError: Cannot read properties of undefined';
    const { store } = makeStore({
      tasks: [
        task('wf-1/a', shared),
        task('wf-2/b', shared),
        task('wf-3/c', shared),
        task('wf-old/d', shared),
      ],
      events: [
        event(1, 'wf-1/a', '2026-09-24T10:00:00.000Z'),
        event(2, 'wf-2/b', '2026-09-24T10:30:00.000Z'),
        event(3, 'wf-3/c', '2026-09-24T11:00:00.000Z'),
        event(4, 'wf-old/d', '2026-09-22T11:00:00.000Z'),
      ],
    });

    expect(collectThrashDetections({
      logger,
      store,
      thresholdCount: 3,
      windowHours: 24,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    })).toHaveLength(1);

    expect(collectThrashDetections({
      logger,
      store,
      thresholdCount: 4,
      windowHours: 24,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    })).toHaveLength(0);
  });

  it('groups the same normalized signature across task ids and keeps different signatures separate', () => {
    const { store } = makeStore({
      tasks: [
        task('wf-1/a', 'pnpm test failed: expected true to be false'),
        task('wf-2/b', 'pnpm test failed: expected true to be false'),
        task('wf-3/c', 'tsc failed: cannot find module'),
      ],
      events: [
        event(1, 'wf-1/a', '2026-09-24T10:00:00.000Z'),
        event(2, 'wf-2/b', '2026-09-24T10:05:00.000Z'),
        event(3, 'wf-3/c', '2026-09-24T10:10:00.000Z'),
      ],
    });

    const detections = collectThrashDetections({
      logger,
      store,
      thresholdCount: 2,
      windowHours: 2,
      now: () => new Date('2026-09-24T11:00:00.000Z'),
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.matchingTaskIds).toEqual(['wf-1/a', 'wf-2/b']);
    expect(detections[0]?.count).toBe(2);
    expect(detections[0]?.signatureBasis.terminalOutput).toContain('expected true to be false');
  });

  it('logs one thrash.detected audit event per signature and does not emit duplicates', async () => {
    const shared = 'vitest failed: timeout exceeded';
    const { store, logged } = makeStore({
      tasks: [task('wf-1/a', shared), task('wf-2/b', shared), task('wf-3/c', shared)],
      events: [
        event(1, 'wf-1/a', '2026-09-24T10:00:00.000Z'),
        event(2, 'wf-2/b', '2026-09-24T10:05:00.000Z'),
        event(3, 'wf-3/c', '2026-09-24T10:10:00.000Z'),
      ],
    });

    await runThrashDetectorTick({
      logger,
      store,
      thresholdCount: 3,
      windowHours: 2,
      now: () => new Date('2026-09-24T11:00:00.000Z'),
    });
    await runThrashDetectorTick({
      logger,
      store: {
        ...store,
        listTaskEvents: vi.fn((filters?: { eventTypes?: readonly string[]; sortBy?: 'asc' | 'desc' }) => {
          const detected = logged.map((entry, index) => ({
            id: 100 + index,
            taskId: entry.taskId,
            eventType: entry.eventType,
            createdAt: '2026-09-24T11:00:00.000Z',
            payload: JSON.stringify(entry.payload),
          }));
          return [...store.listTaskEvents(filters), ...detected]
            .filter((entry) => !filters?.eventTypes || filters.eventTypes.includes(entry.eventType))
            .sort((a, b) => filters?.sortBy === 'asc' ? a.id - b.id : b.id - a.id);
        }),
      },
      thresholdCount: 3,
      windowHours: 2,
      now: () => new Date('2026-09-24T11:30:00.000Z'),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(logged[0]?.payload).toMatchObject({
      kind: THRASH_DETECTOR_WORKER_KIND,
      matchingTaskIds: ['wf-1/a', 'wf-2/b', 'wf-3/c'],
      count: 3,
      thresholdCount: 3,
    });
  });

  it('never calls a mutation submitter when registered through runtime deps', async () => {
    const shared = 'build failed: missing export';
    const { store } = makeStore({
      tasks: [task('wf-1/a', shared), task('wf-2/b', shared), task('wf-3/c', shared)],
      events: [
        event(1, 'wf-1/a', '2026-09-24T10:00:00.000Z'),
        event(2, 'wf-2/b', '2026-09-24T10:05:00.000Z'),
        event(3, 'wf-3/c', '2026-09-24T10:10:00.000Z'),
      ],
    });
    const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string) => 1);
    const registry = registerThrashDetectorWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const runtime = registry.get(THRASH_DETECTOR_WORKER_KIND)!.factory({
      store: store as never,
      submitter: { submit } as never,
      logger,
      thrashDetector: {
        thresholdCount: 3,
        windowHours: 2,
        now: () => new Date('2026-09-24T11:00:00.000Z'),
        tickOnStart: false,
      },
    });

    await runtime.tick('manual');

    expect(submit).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledWith(
      expect.any(String),
      THRASH_DETECTED_EVENT_TYPE,
      expect.objectContaining({ count: 3 }),
    );
  });
});
