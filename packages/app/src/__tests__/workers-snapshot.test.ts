import { describe, expect, it } from 'vitest';
import type { TaskEvent, WorkerActionRecord } from '@invoker/data-store';

import { buildWorkersSnapshot } from '../workers-snapshot.js';

const action = (overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord => ({
  id: 'wa-1',
  workerKind: 'ci-failure',
  actionType: 'fix-ci-failure',
  workflowId: 'wf-1',
  taskId: 'wf-1/task-1',
  subjectType: 'check',
  subjectId: 'test',
  externalKey: 'wf-1/task-1:test',
  status: 'running',
  attemptCount: 1,
  summary: 'Fix failing CI',
  payload: { check: 'unit' },
  createdAt: '2026-07-06T09:00:00.000Z',
  updatedAt: '2026-07-06T09:01:00.000Z',
  ...overrides,
});

const event = (overrides: Partial<TaskEvent> = {}): TaskEvent => ({
  id: 1,
  taskId: 'wf-1/task-1',
  eventType: 'debug.auto-fix',
  payload: JSON.stringify({ phase: 'worker-autofix-skip', reason: 'already-queued-intent', workflowId: 'wf-1' }),
  createdAt: '2026-07-06T09:02:00.000Z',
  ...overrides,
});

describe('buildWorkersSnapshot', () => {
  it('returns built-in workers, external workers, running state, and recent worker action logs', () => {
    const snapshot = buildWorkersSnapshot({
      invokerConfig: {
        externalWorkers: [{
          kind: 'preview',
          launch: { executable: '/usr/local/bin/preview-worker' },
        }],
      },
      ownerWorkers: [{ kind: 'ci-failure', runtime: { isRunning: () => true } }],
      now: () => new Date('2026-07-06T10:00:00.000Z'),
      persistence: {
        listWorkerActions: ({ workerKind }) => (workerKind === 'ci-failure' ? [action()] : []),
        listTaskEvents: () => [],
      },
    });

    expect(snapshot.generatedAt).toBe('2026-07-06T10:00:00.000Z');
    expect(snapshot.workers.map((worker) => `${worker.source}:${worker.kind}`)).toEqual([
      'built-in:autofix',
      'built-in:pr-status',
      'built-in:ci-failure',
      'external:preview',
    ]);
    expect(snapshot.workers.find((worker) => worker.kind === 'ci-failure')).toMatchObject({
      availability: 'available',
      running: true,
      recentLogs: [expect.objectContaining({
        source: 'worker_action',
        actionType: 'fix-ci-failure',
        status: 'running',
        summary: 'Fix failing CI',
      })],
    });
  });

  it('adds auto-fix debug and recovery task events to the auto-fix recent logs', () => {
    const snapshot = buildWorkersSnapshot({
      invokerConfig: {},
      now: () => new Date('2026-07-06T10:00:00.000Z'),
      persistence: {
        listWorkerActions: () => [],
        listTaskEvents: ({ eventTypes }) => {
          expect(eventTypes).toContain('debug.auto-fix');
          expect(eventTypes).toContain('recovery.worker.skip');
          return [
            event(),
            event({
              id: 2,
              eventType: 'recovery.worker.skip',
              payload: JSON.stringify({ action: 'skip', phase: 'schedule-skip', reason: 'already-queued-intent', workflowId: 'wf-1' }),
              createdAt: '2026-07-06T09:03:00.000Z',
            }),
          ];
        },
      },
    });

    const autofix = snapshot.workers.find((worker) => worker.kind === 'autofix');
    expect(autofix?.recentLogs).toEqual([
      expect.objectContaining({
        source: 'task_event',
        eventType: 'recovery.worker.skip',
        phase: 'schedule-skip',
        action: 'skip',
        reason: 'already-queued-intent',
      }),
      expect.objectContaining({
        source: 'task_event',
        eventType: 'debug.auto-fix',
        phase: 'worker-autofix-skip',
        reason: 'already-queued-intent',
      }),
    ]);
  });
});
