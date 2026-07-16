import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { ReviewGateMergeConflictLifecycleEvent } from '../lifecycle-events.js';
import {
  REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
  createReviewGateMergeConflictTick,
  reviewGateMergeConflictActionKey,
} from '../workers/review-gate-merge-conflict-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, ...(config ?? {}) },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/conflict',
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
      ...(execution ?? {}),
    },
    taskStateVersion: 10,
    ...rest,
  } as TaskState;
}

function makeEvent(overrides: Partial<ReviewGateMergeConflictLifecycleEvent> = {}): ReviewGateMergeConflictLifecycleEvent {
  return {
    eventKey: 'review_gate.merge_conflict|workflow:wf-1|task:wf-1/merge',
    kind: 'review_gate.merge_conflict',
    workflowId: 'wf-1',
    taskId: 'wf-1/merge',
    status: 'review_ready',
    taskStateVersion: 10,
    generation: 2,
    attemptId: 'attempt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/conflict',
    branch: 'feature/conflict',
    statusText: 'Merge conflict',
    ...overrides,
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

function makeHarness(task = makeTask(), existingIntents: WorkflowMutationIntent[] = []) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const intents = [...existingIntents];
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('high');
    expect(channel).toBe('invoker:rebase-recreate');
    expect(args).toEqual(['wf-1']);
    return 42;
  });
  const store = {
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn((workflowId?: string, statuses?: string[]) => intents.filter((intent) => (
      (!workflowId || intent.workflowId === workflowId)
      && (!statuses || statuses.includes(intent.status))
    ))),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { actions, store, submit };
}

describe('review-gate merge-conflict worker', () => {
  it('queues one high-priority rebase-recreate intent for a valid event', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.actions.get(`${REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND}:${reviewGateMergeConflictActionKey(event)}`)).toMatchObject({
      workerKind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
      actionType: 'rebase-recreate-review-gate-conflict',
      status: 'queued',
      intentId: '42',
      externalKey: reviewGateMergeConflictActionKey(event),
    });
  });

  it('deduplicates duplicate event keys inside one drain', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event, event],
    });

    await tick({ identity: { kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('records an already-queued-intent skip when a recreate intent is already open', async () => {
    const event = makeEvent();
    const harness = makeHarness(makeTask(), [{
      id: 73,
      workflowId: 'wf-1',
      priority: 'high',
      channel: 'invoker:rebase-recreate',
      args: ['wf-1'],
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.actions.get(`${REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND}:${reviewGateMergeConflictActionKey(event)}`)).toMatchObject({
      status: 'queued',
      intentId: '73',
      payload: expect.objectContaining({
        reason: 'already-queued-intent',
        existingIntentIds: [73],
      }),
    });
  });

  it.each([
    {
      name: 'workflowId changed',
      task: makeTask({ config: { workflowId: 'wf-2', isMergeNode: true } }),
    },
    {
      name: 'reviewId changed',
      task: makeTask({
        execution: {
          reviewGate: {
            activeGeneration: 2,
            completion: { required: 'all', status: 'approved' },
            artifacts: [{
              id: 'pr-456',
              providerId: '456',
              provider: 'github',
              required: true,
              status: 'open',
              generation: 2,
              headSha: 'sha-1',
            }],
          },
        },
      }),
    },
    {
      name: 'generation changed',
      task: makeTask({ execution: { generation: 3 } }),
    },
    {
      name: 'selectedAttemptId changed',
      task: makeTask({ execution: { selectedAttemptId: 'attempt-2' } }),
    },
    {
      name: 'headSha changed',
      task: makeTask({
        execution: {
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
              headSha: 'sha-2',
            }],
          },
        },
      }),
    },
  ])('skips stale lineage when $name', async ({ task }) => {
    const event = makeEvent();
    const harness = makeHarness(task);
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.store.upsertWorkerAction).not.toHaveBeenCalled();
  });
});
