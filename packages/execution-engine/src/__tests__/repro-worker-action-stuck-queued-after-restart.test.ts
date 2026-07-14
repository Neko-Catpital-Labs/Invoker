/**
 * Repro: after owner SIGKILL mid-tick, a worker_actions row can stay `queued`
 * while its linked mutation intent is already terminal. Tick-time reconcile in
 * ci-failure-worker only runs when a lifecycle event is drained — a cold start
 * with no wake event leaves the UI showing a forever-queued repair.
 *
 * Fixed behavior: `reconcileTerminalWorkerActionsOnStartup` folds terminal
 * intents into open action rows before workers tick.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
} from '@invoker/data-store';

import { reconcileTerminalWorkerActionsOnStartup } from '../reconcile-terminal-worker-actions.js';
import { CI_FAILURE_WORKER_KIND, ciFailureActionKey } from '../workers/ci-failure-worker.js';

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

describe('worker action stuck queued after terminal intent (startup gap)', () => {
  it('fixed: startup sweep marks queued actions completed when their intent is terminal', () => {
    const externalKey = ciFailureActionKey({
      taskId: 'wf-1/merge',
      reviewId: '123',
      headSha: 'sha-1',
      failedChecks: [{ name: 'PR Body', conclusion: 'CANCELLED', detailsUrl: 'https://example.test/1' }],
    });

    const actions = new Map<string, WorkerActionRecord>();
    actions.set(`${CI_FAILURE_WORKER_KIND}:${externalKey}`, toRecord({
      id: `${CI_FAILURE_WORKER_KIND}:${externalKey}`,
      workerKind: CI_FAILURE_WORKER_KIND,
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      subjectType: 'review',
      subjectId: '123',
      externalKey,
      status: 'queued',
      attemptCount: 1,
      intentId: '27908',
      summary: 'Queued CI repair with agent',
    }));

    const intents: WorkflowMutationIntent[] = [{
      id: 27908,
      workflowId: 'wf-1',
      channel: 'invoker:fix-with-agent',
      args: [],
      priority: 'normal',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    }];

    const store = {
      listWorkerActions: vi.fn((filters?: { status?: string }) =>
        Array.from(actions.values()).filter((row) => !filters?.status || row.status === filters.status),
      ),
      listWorkflowMutationIntents: vi.fn((_workflowId?: string, statuses?: WorkflowMutationIntentStatus[]) =>
        intents.filter((intent) => !statuses || statuses.includes(intent.status)),
      ),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const saved = toRecord(write);
        actions.set(`${write.workerKind}:${write.externalKey}`, saved);
        return saved;
      }),
    };

    const reconciled = reconcileTerminalWorkerActionsOnStartup(store, new Date('2026-01-02T00:00:00.000Z'));

    expect(reconciled).toBe(1);
    expect(store.upsertWorkerAction).toHaveBeenCalledTimes(1);
    expect(actions.get(`${CI_FAILURE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      status: 'completed',
      summary: 'Worker action reconciled from completed intent on startup',
      completedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(store.listWorkerActions({ status: 'queued' })).toHaveLength(0);
  });
});
