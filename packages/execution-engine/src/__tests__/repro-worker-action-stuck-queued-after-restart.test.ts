/**
 * Repro: after owner SIGKILL mid-tick, a worker_actions row can stay `queued`
 * while its linked mutation intent is already terminal. Tick-time reconcile in
 * ci-failure-worker only runs when a lifecycle event is drained — a cold start
 * with no wake event leaves the UI showing a forever-queued repair.
 *
 * This test freezes that durable stuck state. The follow-up fix adds a startup
 * sweep that folds terminal intents into open action rows before workers tick.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
} from '@invoker/data-store';

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
  it('issue: queued action remains queued after restart when no tick drains events', () => {
    const externalKey = ciFailureActionKey({
      eventKey: 'review_gate.ci_failed|workflow:wf-1|task:wf-1/merge',
      kind: 'review_gate.ci_failed',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      taskStateVersion: 10,
      generation: 2,
      attemptId: 'attempt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      recoveryWakeup: {
        eventKey: 'review_gate.ci_failed|workflow:wf-1|task:wf-1/merge',
        eventKind: 'review_gate.ci_failed',
        workflowId: 'wf-1',
        taskId: 'wf-1/merge',
        taskStateVersion: 10,
        generation: 2,
        attemptId: 'attempt-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        reason: 'review_gate_failure',
        authoritative: false,
      },
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      headRef: 'feature/ci',
      branch: 'feature/ci',
      failedChecks: [{ name: 'PR Body', conclusion: 'CANCELLED', detailsUrl: 'https://example.test/1' }],
      statusText: 'Awaiting review',
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

    // Simulate cold restart: persistence still has the rows, but no worker tick ran.
    const store = {
      listWorkerActions: vi.fn((filters?: { status?: string }) =>
        Array.from(actions.values()).filter((row) => !filters?.status || row.status === filters.status),
      ),
      listWorkflowMutationIntents: vi.fn((_workflowId?: string, statuses?: WorkflowMutationIntentStatus[]) =>
        intents.filter((intent) => !statuses || statuses.includes(intent.status)),
      ),
      upsertWorkerAction: vi.fn(),
    };

    const open = store.listWorkerActions({ status: 'queued' });
    expect(open).toHaveLength(1);
    expect(open[0]?.intentId).toBe('27908');
    expect(store.listWorkflowMutationIntents('wf-1', ['completed', 'failed'])[0]?.status).toBe('completed');
    // Without a startup sweep, nothing folds the terminal intent into the action.
    expect(store.upsertWorkerAction).not.toHaveBeenCalled();
    expect(actions.get(`${CI_FAILURE_WORKER_KIND}:${externalKey}`)?.status).toBe('queued');
  });
});
