import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationIntent } from '@invoker/data-store';

import { reconcileTerminalWorkerActionsOnStartup } from '../reconcile-terminal-worker-actions.js';

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('reconcileTerminalWorkerActionsOnStartup', () => {
  it('leaves open intents untouched and reconciles failed intents', () => {
    const actions = new Map<string, WorkerActionRecord>();
    actions.set('a', toRecord({
      id: 'a',
      workerKind: 'ci-failure',
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/t',
      subjectType: 'review',
      subjectId: '1',
      externalKey: 'a',
      status: 'queued',
      intentId: '1',
    }));
    actions.set('b', toRecord({
      id: 'b',
      workerKind: 'ci-failure',
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/t2',
      subjectType: 'review',
      subjectId: '2',
      externalKey: 'b',
      status: 'queued',
      intentId: '2',
    }));

    const intents: WorkflowMutationIntent[] = [
      {
        id: 1,
        workflowId: 'wf-1',
        channel: 'invoker:fix-with-agent',
        args: [],
        priority: 'normal',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        workflowId: 'wf-1',
        channel: 'invoker:fix-with-agent',
        args: [],
        priority: 'normal',
        status: 'failed',
        error: 'boom\nstack',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const store = {
      listWorkerActions: (filters?: { status?: string }) =>
        Array.from(actions.values()).filter((row) => !filters?.status || row.status === filters.status),
      listWorkflowMutationIntents: (_workflowId?: string, statuses?: Array<'completed' | 'failed' | 'running' | 'queued'>) =>
        intents.filter((intent) => !statuses || statuses.includes(intent.status)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const saved = toRecord(write);
        actions.set(write.id, saved);
        return saved;
      }),
    };

    expect(reconcileTerminalWorkerActionsOnStartup(store)).toBe(1);
    expect(actions.get('a')?.status).toBe('queued');
    expect(actions.get('b')).toMatchObject({
      status: 'failed',
      summary: 'Worker action reconciled from failed intent on startup: boom',
    });
  });

  it('preserves store method binding when listing terminal intents', () => {
    const actions = new Map<string, WorkerActionRecord>([
      ['a', toRecord({
        id: 'a',
        workerKind: 'ci-failure',
        actionType: 'fix-ci-failure',
        workflowId: 'wf-1',
        taskId: 'wf-1/t',
        subjectType: 'review',
        subjectId: '1',
        externalKey: 'a',
        status: 'queued',
        intentId: '9',
      })],
    ]);
    const store = {
      listWorkerActions: () => Array.from(actions.values()),
      listWorkflowMutationIntents(workflowId?: string) {
        expect(this).toBe(store);
        expect(workflowId).toBe('wf-1');
        return [{
          id: 9,
          workflowId: 'wf-1',
          channel: 'invoker:fix-with-agent',
          args: [],
          priority: 'normal' as const,
          status: 'completed' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
        }];
      },
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const saved = toRecord(write);
        actions.set(write.id, saved);
        return saved;
      }),
    };

    expect(reconcileTerminalWorkerActionsOnStartup(store)).toBe(1);
    expect(actions.get('a')?.status).toBe('completed');
  });
});
