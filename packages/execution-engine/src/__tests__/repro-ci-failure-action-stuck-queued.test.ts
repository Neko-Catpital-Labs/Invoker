/**
 * Repro: a review-gate CI repair stays "queued" forever after its fix intent
 * fails.
 *
 * Production failure (workflow "Prove Review Gate Fix No-op Root Cause"):
 * the ci-failure worker recorded its dedupe action as `queued` when it
 * submitted fix intent 27908. The intent failed 50ms later, but nothing wrote
 * that outcome back to the worker action. From then on every tick logged
 *
 *   worker-ci-failure-skip reason=already-recorded existingStatus=queued
 *
 * because `shouldSkipExistingAction` treats `queued` as open work. The UI
 * showed a repair "queued up" that would never execute, and the worker never
 * retried the same failed check.
 *
 * Fixed behavior, proven here: before the dedupe check, the worker folds a
 * terminal intent outcome back into the action row. A failed intent marks the
 * action `failed` and the same tick requeues a fresh repair (bounded by the
 * attempt ledger); a completed intent marks the action `completed` and stays
 * deduped; an intent that is still open keeps the action queued untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  CI_FAILURE_WORKER_KIND,
  ciFailureActionKey,
  createCiFailureTick,
} from '../workers/ci-failure-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          headSha: 'sha-1',
        }],
      },
    },
    taskStateVersion: 10,
  } as unknown as TaskState;
}

function makeEvent(): ReviewGateCiFailedLifecycleEvent {
  return {
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
    failedChecks: [
      { name: 'PR Body', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/owner/repo/actions/1' },
    ],
    statusText: 'Awaiting review',
  };
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeIntent(id: number, status: WorkflowMutationIntentStatus, error?: string): WorkflowMutationIntent {
  return {
    id,
    workflowId: 'wf-1',
    channel: 'invoker:fix-with-agent',
    args: ['wf-1/merge', 'codex', { autoFix: true }],
    priority: 'normal',
    status,
    error,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeHarness(opts: { intents: WorkflowMutationIntent[]; existingActionStatus: string; existingIntentId: string }) {
  const task = makeTask();
  const event = makeEvent();
  const externalKey = ciFailureActionKey(event);
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
    status: opts.existingActionStatus as WorkerActionRecord['status'],
    attemptCount: 1,
    intentId: opts.existingIntentId,
    summary: 'Queued CI repair with agent',
  }));
  const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string, _args: unknown[]) => 42);
  const store = {
    loadTasks: vi.fn(() => [task]),
    loadTask: vi.fn(() => task),
    listWorkflowMutationIntents: vi.fn((_workflowId?: string, statuses?: WorkflowMutationIntentStatus[]) =>
      opts.intents.filter((intent) => !statuses || statuses.includes(intent.status)),
    ),
    getWorkerAction: vi.fn((workerKind: string, key: string) => actions.get(`${workerKind}:${key}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const tick = createCiFailureTick({
    store,
    submitter: { submit },
    logger,
    attemptLedger: createAutoFixAttemptLedger(),
    defaultAutoFixRetries: 10,
    getAutoFixAgent: () => 'codex',
    drainEvents: () => [event],
  });
  const runTick = () => tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });
  return { actions, store, submit, event, externalKey, runTick };
}

describe('ci-failure worker stale queued action (repro)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fixed: a failed intent flips the queued action to failed and requeues the repair', async () => {
    const h = makeHarness({
      intents: [makeIntent(27908, 'failed', 'Error: Task wf-1/merge is not failed (status: review_ready)\n    at beginConflictResolutionImpl')],
      existingActionStatus: 'queued',
      existingIntentId: '27908',
    });

    await h.runTick();

    // The stale queued action was reconciled from the failed intent...
    const failedWrite = h.store.upsertWorkerAction.mock.calls
      .map(([write]) => write)
      .find((write) => write.status === 'failed');
    expect(failedWrite).toMatchObject({
      status: 'failed',
      summary: 'CI repair intent failed: Error: Task wf-1/merge is not failed (status: review_ready)',
      attemptCount: 1,
    });

    // ...and the same tick requeued a fresh repair instead of skipping with
    // reason=already-recorded forever.
    expect(h.submit).toHaveBeenCalledTimes(1);
    const final = h.actions.get(`${CI_FAILURE_WORKER_KIND}:${h.externalKey}`);
    expect(final).toMatchObject({ status: 'queued', intentId: '42', attemptCount: 2 });
  });

  it('fixed: a completed intent flips the queued action to completed without requeueing', async () => {
    const h = makeHarness({
      intents: [makeIntent(27908, 'completed')],
      existingActionStatus: 'queued',
      existingIntentId: '27908',
    });

    await h.runTick();

    expect(h.submit).not.toHaveBeenCalled();
    const final = h.actions.get(`${CI_FAILURE_WORKER_KIND}:${h.externalKey}`);
    expect(final).toMatchObject({ status: 'completed', summary: 'CI repair intent completed' });
  });

  it('an open intent leaves the queued action deduped and does not resubmit', async () => {
    const h = makeHarness({
      intents: [makeIntent(27908, 'running')],
      existingActionStatus: 'queued',
      existingIntentId: '27908',
    });

    await h.runTick();

    expect(h.submit).not.toHaveBeenCalled();
    const final = h.actions.get(`${CI_FAILURE_WORKER_KIND}:${h.externalKey}`);
    expect(final).toMatchObject({ status: 'queued', intentId: '27908', attemptCount: 1 });
  });
});
