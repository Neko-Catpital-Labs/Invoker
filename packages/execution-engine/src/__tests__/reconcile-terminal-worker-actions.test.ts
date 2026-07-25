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

  it('releases PR repair leases for reconciled review-comment and queue-dequeue actions', () => {
    const reviewAction = toRecord({
      id: 'a',
      workerKind: 'review-comments',
      actionType: 'address-review-comments',
      workflowId: 'wf-1',
      subjectType: 'pull_request',
      subjectId: 'owner/repo#1',
      externalKey: 'a',
      status: 'queued',
      intentId: '9',
      payload: { prRepairLeaseId: 'lease-1' },
    });
    const queueAction = toRecord({
      id: 'b',
      workerKind: 'pr-queue-land',
      actionType: 'land-dequeued-pr',
      workflowId: 'wf-2',
      subjectType: 'pull_request',
      subjectId: 'owner/repo#2',
      externalKey: 'b',
      status: 'running',
      intentId: '10',
      payload: { prRepairLeaseId: 'lease-2' },
    });
    const actions = new Map<string, WorkerActionRecord>([
      ['a', reviewAction],
      ['b', queueAction],
    ]);
    const deletePrRepairLeaseById = vi.fn(() => true);
    const store = {
      listWorkerActions: () => Array.from(actions.values()),
      listWorkflowMutationIntents: (workflowId?: string) => {
        if (workflowId === 'wf-1') {
          return [{
            id: 9,
            workflowId: 'wf-1',
            channel: 'invoker:repair-review-comments',
            args: [],
            priority: 'normal' as const,
            status: 'completed' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
          }];
        }
        if (workflowId === 'wf-2') {
          return [{
            id: 10,
            workflowId: 'wf-2',
            channel: 'invoker:repair-queue-dequeue',
            args: [],
            priority: 'high' as const,
            status: 'failed' as const,
            error: 'queue still blocked',
            createdAt: '2026-01-01T00:00:00.000Z',
          }];
        }
        return [];
      },
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const saved = toRecord(write);
        actions.set(saved.id, saved);
        return saved;
      }),
      deletePrRepairLeaseById,
    };

    expect(reconcileTerminalWorkerActionsOnStartup(store)).toBe(2);
    expect(deletePrRepairLeaseById).toHaveBeenCalledWith('lease-1');
    expect(deletePrRepairLeaseById).toHaveBeenCalledWith('lease-2');
    expect(actions.get('a')).toMatchObject({ status: 'completed', payload: expect.objectContaining({ reconciledIntentStatus: 'completed' }) });
    expect(actions.get('b')).toMatchObject({ status: 'failed', payload: expect.objectContaining({ reconciledIntentStatus: 'failed', intentError: 'queue still blocked' }) });
  });
});
