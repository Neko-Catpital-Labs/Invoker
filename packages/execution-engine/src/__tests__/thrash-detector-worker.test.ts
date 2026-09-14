import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@invoker/data-store';

import {
  buildThrashSignatureId,
  runThrashDetectorTick,
  THRASH_DETECTED_EVENT_TYPE,
  THRASH_DETECTOR_WORKER_KIND,
  type ThrashDetectorWorkerStore,
} from '../workers/thrash-detector-worker.js';

function event(id: number, taskId: string, createdAt: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id,
    taskId,
    eventType: 'debug.auto-fix',
    payload: JSON.stringify(payload),
    createdAt,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeStore(events: TaskEvent[]): { store: ThrashDetectorWorkerStore; writes: TaskEvent[] } {
  const writes: TaskEvent[] = [];
  return {
    writes,
    store: {
      listTaskEvents: () => [...events, ...writes],
      logEvent: (taskId, eventType, payload) => {
        writes.push({
          id: 10_000 + writes.length,
          taskId,
          eventType,
          payload: JSON.stringify(payload),
          createdAt: '2026-09-14T12:00:00.000Z',
        });
      },
    },
  };
}

describe('runThrashDetectorTick', () => {
  it('applies threshold and window math before logging one thrash.detected event', async () => {
    const { store, writes } = makeStore([
      event(1, 'task-a', '2026-09-14T10:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'TypeError: taskResult is undefined' }),
      event(2, 'task-b', '2026-09-14T11:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'TypeError: taskResult is undefined' }),
      event(3, 'task-c', '2026-09-13T09:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'TypeError: taskResult is undefined' }),
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 4,
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.eventType).toBe(THRASH_DETECTED_EVENT_TYPE);
    expect(JSON.parse(writes[0]?.payload ?? '{}')).toMatchObject({
      kind: THRASH_DETECTOR_WORKER_KIND,
      count: 2,
      matchingTaskIds: ['task-a', 'task-b'],
      window: {
        hours: 4,
        since: '2026-09-14T08:00:00.000Z',
        until: '2026-09-14T12:00:00.000Z',
      },
    });
  });

  it('groups the same normalized signature across task ids and keeps different signatures separate', async () => {
    const sameA = event(1, 'task-a', '2026-09-14T10:00:00.000Z', {
      phase: 'worker-autofix-submitted',
      terminalOutput: 'ERR_PNPM_UNSUPPORTED_ENGINE at /tmp/a line 12',
    });
    const sameB = event(2, 'task-b', '2026-09-14T10:10:00.000Z', {
      phase: 'worker-autofix-submitted',
      terminalOutput: 'ERR_PNPM_UNSUPPORTED_ENGINE at /Users/test/b line 99',
    });
    const different = event(3, 'task-c', '2026-09-14T10:20:00.000Z', {
      phase: 'worker-autofix-submitted',
      terminalOutput: 'fatal: authentication failed',
    });
    const { store, writes } = makeStore([sameA, sameB, different]);

    expect(buildThrashSignatureId(sameA)).toBe(buildThrashSignatureId(sameB));
    expect(buildThrashSignatureId(sameA)).not.toBe(buildThrashSignatureId(different));

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.payload ?? '{}').matchingTaskIds).toEqual(['task-a', 'task-b']);
  });

  it('does not log the same signature twice within the configured window', async () => {
    const priorSignature = buildThrashSignatureId(event(1, 'task-a', '2026-09-14T10:00:00.000Z', {
      phase: 'worker-autofix-submitted',
      terminalOutput: 'fatal: lock file exists',
    }));
    const { store, writes } = makeStore([
      event(1, 'task-a', '2026-09-14T10:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'fatal: lock file exists' }),
      event(2, 'task-b', '2026-09-14T11:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'fatal: lock file exists' }),
      {
        id: 3,
        taskId: 'task-a',
        eventType: THRASH_DETECTED_EVENT_TYPE,
        payload: JSON.stringify({ signatureId: priorSignature }),
        createdAt: '2026-09-14T11:30:00.000Z',
      },
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    });

    expect(writes).toHaveLength(0);
  });

  it('never calls any mutation channel', async () => {
    const forbidden = {
      submit: vi.fn(() => {
        throw new Error('mutation submitter must not be called');
      }),
      approveTask: vi.fn(),
      rejectTask: vi.fn(),
      recreateTask: vi.fn(),
    };
    const { store } = makeStore([
      event(1, 'task-a', '2026-09-14T10:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'same failure' }),
      event(2, 'task-b', '2026-09-14T11:00:00.000Z', { phase: 'worker-autofix-submitted', terminalOutput: 'same failure' }),
    ]);

    await runThrashDetectorTick({
      logger: makeLogger(),
      store: { ...store, ...forbidden } as unknown as ThrashDetectorWorkerStore,
      thresholdCount: 2,
      windowHours: 24,
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    });

    expect(forbidden.submit).not.toHaveBeenCalled();
    expect(forbidden.approveTask).not.toHaveBeenCalled();
    expect(forbidden.rejectTask).not.toHaveBeenCalled();
    expect(forbidden.recreateTask).not.toHaveBeenCalled();
  });

  it('keeps the source free of forbidden mutation channel strings', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../workers/thrash-detector-worker.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/invoker:fix-with-agent|invoker:approve|invoker:reject|recreate-task|recreateTask|approveTask|rejectTask|submitter\.|\.submit\(/);
  });
});
