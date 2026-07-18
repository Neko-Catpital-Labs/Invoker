import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';

import { reconcileTerminalWorkerActionsOnStartup } from '../reconcile-terminal-worker-actions.js';

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function buildQueuedAction(id: string, intentId: string): WorkerActionWrite {
  return {
    id,
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/t',
    subjectType: 'review',
    subjectId: '1',
    externalKey: id,
    status: 'queued',
    intentId,
  };
}

describe('repro: deferred startup reconcile method binding', () => {
  it('fails like production when listWorkflowMutationIntents is extracted without bind', () => {
    const store = {
      listWorkflowMutationIntents(workflowId?: string) {
        if (!workflowId) return [];
        return this.queryAll(workflowId);
      },
      queryAll(workflowId: string) {
        return workflowId === 'wf-1'
          ? [{ id: 9, workflowId: 'wf-1', channel: 'x', args: [], priority: 'normal', status: 'completed', createdAt: 't' }]
          : [];
      },
    };
    const unboundList = store.listWorkflowMutationIntents;
    expect(() => unboundList('wf-1', ['completed', 'failed'])).toThrow(
      /Cannot read properties of undefined \(reading 'queryAll'\)/,
    );
  });

  it('queries terminal intents once per workflow during startup reconcile', () => {
    const actions = [
      toRecord(buildQueuedAction('a', '9')),
      toRecord(buildQueuedAction('b', '9')),
    ];
    const listWorkflowMutationIntents = vi.fn((workflowId?: string) => {
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
    });
    const store = {
      listWorkerActions: () => actions,
      listWorkflowMutationIntents,
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => toRecord(write)),
    };

    expect(reconcileTerminalWorkerActionsOnStartup(store)).toBe(2);
    expect(listWorkflowMutationIntents).toHaveBeenCalledTimes(1);
  });
});
