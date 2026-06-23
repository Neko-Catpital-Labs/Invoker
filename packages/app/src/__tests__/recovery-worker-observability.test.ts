import { describe, expect, it } from 'vitest';

import {
  buildRecoveryWorkerAuditPayload,
  collectRecoveryWorkerStatus,
  recoveryWorkerEventType,
} from '../recovery-worker-observability.js';

describe('recovery-worker-observability', () => {
  it('derives recovery ownership and latest decisions from task audit events', () => {
    const workflows = [{ id: 'wf-1' }];
    const tasks = [{ id: 'wf-1/task-a' }, { id: 'wf-1/task-b' }];
    const eventsByTask = new Map([
      ['wf-1/task-a', [
        {
          id: 1,
          taskId: 'wf-1/task-a',
          eventType: recoveryWorkerEventType('wakeup'),
          payload: JSON.stringify(buildRecoveryWorkerAuditPayload('wakeup', 'delta-failed', { workflowId: 'wf-1' })),
          createdAt: '2026-06-22T10:00:00.000Z',
        },
        {
          id: 2,
          taskId: 'wf-1/task-a',
          eventType: recoveryWorkerEventType('skip'),
          payload: JSON.stringify(buildRecoveryWorkerAuditPayload('skip', 'delta-skip', { workflowId: 'wf-1', reason: 'cancellation-error' })),
          createdAt: '2026-06-22T10:00:01.000Z',
        },
      ]],
      ['wf-1/task-b', [
        {
          id: 3,
          taskId: 'wf-1/task-b',
          eventType: recoveryWorkerEventType('scan'),
          payload: JSON.stringify(buildRecoveryWorkerAuditPayload('scan', 'schedule-enter', { workflowId: 'wf-1' })),
          createdAt: '2026-06-22T10:00:02.000Z',
        },
        {
          id: 4,
          taskId: 'wf-1/task-b',
          eventType: recoveryWorkerEventType('submit'),
          payload: JSON.stringify(buildRecoveryWorkerAuditPayload('submit', 'schedule-enqueued', { workflowId: 'wf-1' })),
          createdAt: '2026-06-22T10:00:03.000Z',
        },
        {
          id: 5,
          taskId: 'wf-1/task-b',
          eventType: recoveryWorkerEventType('skip'),
          payload: JSON.stringify(buildRecoveryWorkerAuditPayload('skip', 'schedule-skip', { workflowId: 'wf-1', reason: 'already-queued-intent' })),
          createdAt: '2026-06-22T10:00:04.000Z',
        },
      ]],
    ]);

    const status = collectRecoveryWorkerStatus({
      listWorkflows: () => workflows as never,
      loadTasks: () => tasks as never,
      getEvents: (taskId) => (eventsByTask.get(taskId) ?? []) as never,
    });

    expect(status).toMatchObject({
      kind: 'recovery',
      workerId: 'auto-fix-recovery',
      owner: 'auto-fix',
      lastWakeupAt: '2026-06-22T10:00:00.000Z',
      lastScanAt: '2026-06-22T10:00:02.000Z',
      lastSubmitAt: '2026-06-22T10:00:03.000Z',
      lastSkipAt: '2026-06-22T10:00:04.000Z',
      lastSkipReason: 'already-queued-intent',
      lastSkipTaskId: 'wf-1/task-b',
      wakeups: 1,
      scans: 1,
      submissions: 1,
      skips: 2,
    });
    expect(status.recent[0]).toMatchObject({
      action: 'skip',
      taskId: 'wf-1/task-b',
      reason: 'already-queued-intent',
    });
  });
});
