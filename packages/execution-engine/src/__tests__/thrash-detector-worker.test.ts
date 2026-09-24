import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { describe, expect, it, vi } from 'vitest';

import { registerBuiltinWorkers } from '../builtin-workers.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import {
  runThrashDetectorTick,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function task(id: string, workflowId = 'wf'): TaskState {
  return {
    id,
    description: id,
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

function event(id: number, taskId: string, createdAt: string, phase = 'worker-autofix-skip'): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify({ phase, reason: 'failed' }),
    createdAt,
  };
}

function makeStore(args: {
  events: TaskEvent[];
  outputs: Record<string, string>;
  tasks?: TaskState[];
}): ThrashDetectorWorkerStore & { logged: Array<{ taskId: string; eventType: string; payload?: unknown }> } {
  const tasks = args.tasks ?? Object.keys(args.outputs).map((id) => task(id));
  const logged: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  return {
    logged,
    listWorkflows: () => [{ id: 'wf' }],
    loadTasks: () => tasks,
    loadTask: (taskId) => tasks.find((candidate) => candidate.id === taskId),
    listTaskEvents: (filters = {}) => {
      const allEvents = [...args.events, ...logged.map((entry, index) => ({
        id: 10_000 + index,
        taskId: entry.taskId,
        eventType: entry.eventType,
        payload: JSON.stringify(entry.payload),
        createdAt: '2026-09-24T12:00:00.000Z',
      }))];
      return allEvents
        .filter((candidate) => !filters.eventTypes || filters.eventTypes.includes(candidate.eventType))
        .sort((a, b) => filters.sortBy === 'asc' ? a.id - b.id : b.id - a.id)
        .slice(0, filters.limit ?? allEvents.length);
    },
    getTaskOutput: (taskId) => args.outputs[taskId] ?? '',
    logEvent: (taskId, eventType, payload) => {
      logged.push({ taskId, eventType, payload });
    },
  };
}

const classify = vi.fn((phase: string) => phase.endsWith('-skip') ? 'skip' : undefined);

describe('runThrashDetectorTick', () => {
  it('applies threshold and window math over distinct task ids', async () => {
    const store = makeStore({
      events: [
        event(1, 't1', '2026-09-24T11:55:00.000Z'),
        event(2, 't2', '2026-09-24T11:56:00.000Z'),
        event(3, 't3', '2026-09-24T09:59:59.000Z'),
      ],
      outputs: {
        t1: 'TypeError: cannot read property foo of undefined',
        t2: 'TypeError: cannot read property foo of undefined',
        t3: 'TypeError: cannot read property foo of undefined',
      },
    });

    await runThrashDetectorTick({
      logger: silentLogger,
      store,
      thresholdCount: 3,
      windowHours: 2,
      classifyAutoFixRecoveryPhase: classify,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });
    expect(store.logged).toEqual([]);

    store.listTaskEvents = ((original) => (filters = {}) => [
      ...original(filters),
      event(4, 't3', '2026-09-24T10:01:00.000Z'),
    ])(store.listTaskEvents!);

    await runThrashDetectorTick({
      logger: silentLogger,
      store,
      thresholdCount: 3,
      windowHours: 2,
      classifyAutoFixRecoveryPhase: classify,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });

    expect(store.logged).toHaveLength(1);
    expect(store.logged[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(store.logged[0]?.payload).toMatchObject({
      matchingTaskIds: ['t1', 't2', 't3'],
      count: 3,
      window: {
        hours: 2,
        start: '2026-09-24T10:00:00.000Z',
        end: '2026-09-24T12:00:00.000Z',
      },
    });
  });

  it('groups the same signature across task ids and keeps different signatures separate', async () => {
    const store = makeStore({
      events: [
        event(1, 't1', '2026-09-24T11:55:00.000Z'),
        event(2, 't2', '2026-09-24T11:56:00.000Z'),
        event(3, 't3', '2026-09-24T11:57:00.000Z'),
      ],
      outputs: {
        t1: 'Error: module not found: @invoker/missing',
        t2: 'Error: module not found: @invoker/missing',
        t3: 'Error: permission denied: /tmp/cache',
      },
    });

    await runThrashDetectorTick({
      logger: silentLogger,
      store,
      thresholdCount: 2,
      windowHours: 1,
      classifyAutoFixRecoveryPhase: classify,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });

    expect(store.logged).toHaveLength(1);
    expect(store.logged[0]?.payload).toMatchObject({
      matchingTaskIds: ['t1', 't2'],
      count: 2,
      recoveryAction: 'skip',
      phase: 'worker-autofix-skip',
    });
  });

  it('does not call mutation channels while recording audit events', async () => {
    const store = makeStore({
      events: [
        event(1, 't1', '2026-09-24T11:55:00.000Z'),
        event(2, 't2', '2026-09-24T11:56:00.000Z'),
      ],
      outputs: {
        t1: 'ReferenceError: shared failure',
        t2: 'ReferenceError: shared failure',
      },
    });
    const submit = vi.fn();
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const entry = registry.get(THRASH_DETECTOR_WORKER_KIND);
    expect(entry).toBeDefined();

    const runtime = entry!.factory({
      store: store as WorkerRuntimeDependencies['store'],
      submitter: { submit } as WorkerRuntimeDependencies['submitter'],
      logger: silentLogger,
      thrashDetector: {
        store,
        thresholdCount: 2,
        windowHours: 1,
        tickOnStart: false,
        classifyAutoFixRecoveryPhase: classify,
        now: () => new Date('2026-09-24T12:00:00.000Z'),
      },
    });
    await runtime.tick('manual');

    expect(submit).not.toHaveBeenCalled();
    expect(store.logged).toHaveLength(1);

    const source = readFileSync(fileURLToPath(new URL('../workers/thrash-detector-worker.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/invoker:fix-with-agent|invoker:approve|recreate-task|submitter\.submit|\.submit\(/);
  });
});
