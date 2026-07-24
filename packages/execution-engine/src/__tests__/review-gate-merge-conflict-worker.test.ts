import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationPriority,
} from '@invoker/data-store';
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

function makeEvent(
  overrides: Partial<ReviewGateMergeConflictLifecycleEvent> = {},
): ReviewGateMergeConflictLifecycleEvent {
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
    statusText: 'merge conflict',
    ...overrides,
  } as ReviewGateMergeConflictLifecycleEvent;
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

interface Harness {
  actions: Map<string, WorkerActionRecord>;
  intents: WorkflowMutationIntent[];
  store: {
    loadTasks: ReturnType<typeof vi.fn>;
    loadTask: ReturnType<typeof vi.fn>;
    listWorkflowMutationIntents: ReturnType<typeof vi.fn>;
    getWorkerAction: ReturnType<typeof vi.fn>;
    upsertWorkerAction: ReturnType<typeof vi.fn>;
    logEvent: ReturnType<typeof vi.fn>;
  };
  submit: ReturnType<typeof vi.fn>;
}

function makeHarness(task = makeTask(), intents: WorkflowMutationIntent[] = []): Harness {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('high');
    expect(channel).toBe('invoker:rebase-recreate');
    expect(args).toEqual(['wf-1']);
    return 42;
  });
  const store = {
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn((_workflowId?: string, statuses?: string[]) =>
      intents.filter((intent) => !statuses || statuses.includes(intent.status))),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { actions, intents, store, submit };
}

function actionFor(harness: Harness, event: ReviewGateMergeConflictLifecycleEvent): WorkerActionRecord | undefined {
  return harness.actions.get(
    `${REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND}:${reviewGateMergeConflictActionKey(event)}`,
  );
}

describe('review-gate merge-conflict worker tick', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits one high-priority rebase-recreate intent and records a durable action row', async () => {
    const harness = makeHarness();
    const event = makeEvent();
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick();

    expect(harness.submit).toHaveBeenCalledTimes(1);
    const row = actionFor(harness, event);
    expect(row).toMatchObject({
      workerKind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
      actionType: 'rebase-recreate-review-gate-conflict',
      status: 'queued',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      intentId: '42',
    });
  });

  it('dedupes a duplicate event for the same task/review/headSha', async () => {
    const harness = makeHarness();
    const event = makeEvent();
    const options = {
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
    };
    await createReviewGateMergeConflictTick({ ...options, drainEvents: () => [event, makeEvent()] })();
    expect(harness.submit).toHaveBeenCalledTimes(1);

    // A later tick draining the same event again is stopped by the durable row.
    await createReviewGateMergeConflictTick({ ...options, drainEvents: () => [makeEvent()] })();
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('skips a stale event whose head SHA no longer matches the persisted task, without a durable row', async () => {
    const harness = makeHarness();
    const event = makeEvent({ headSha: 'sha-outdated' });
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick();

    expect(harness.submit).not.toHaveBeenCalled();
    expect(actionFor(harness, event)).toBeUndefined();
  });

  it('skips a stale event whose generation advanced past the persisted task', async () => {
    const harness = makeHarness();
    const event = makeEvent({ generation: 1 });
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick();

    expect(harness.submit).not.toHaveBeenCalled();
    expect(actionFor(harness, event)).toBeUndefined();
  });

  it('does not submit when an open recreate intent already exists for the workflow', async () => {
    const openIntent = {
      id: 7,
      workflowId: 'wf-1',
      channel: 'invoker:rebase-recreate',
      args: ['wf-1'],
      status: 'queued',
      priority: 'high',
    } as unknown as WorkflowMutationIntent;
    const harness = makeHarness(makeTask(), [openIntent]);
    const event = makeEvent();
    const tick = createReviewGateMergeConflictTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      drainEvents: () => [event],
    });

    await tick();

    expect(harness.submit).not.toHaveBeenCalled();
    expect(actionFor(harness, event)).toMatchObject({ status: 'queued', intentId: '7' });
  });

  it('reconciles a finished intent back into the durable action row', async () => {
    const harness = makeHarness();
    const event = makeEvent();
    const options = {
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
    };
    await createReviewGateMergeConflictTick({ ...options, drainEvents: () => [event] })();
    expect(actionFor(harness, event)?.status).toBe('queued');

    harness.intents.push({
      id: 42,
      workflowId: 'wf-1',
      channel: 'invoker:rebase-recreate',
      args: ['wf-1'],
      status: 'failed',
      priority: 'high',
      error: 'recreate blew up\nstack trace',
    } as unknown as WorkflowMutationIntent);

    // Drain a now-stale event (generation moved on): reconcile still folds the
    // terminal intent into the row, and staleness prevents an immediate retry.
    await createReviewGateMergeConflictTick({ ...options, drainEvents: () => [makeEvent({ generation: 1 })] })();

    const reconciled = actionFor(harness, event);
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.summary).toContain('recreate blew up');
    expect(reconciled?.payload).toMatchObject({ reconciledIntentStatus: 'failed' });

    // Draining the original lineage reconciles first, then retries: the row is
    // rewritten as a fresh queued attempt with a new submit.
    await createReviewGateMergeConflictTick({ ...options, drainEvents: () => [makeEvent()] })();
    const row = actionFor(harness, event);
    expect(row?.status).toBe('queued');
    expect(harness.store.upsertWorkerAction.mock.calls.some(([write]: [WorkerActionWrite]) =>
      write.status === 'failed'
      && typeof write.summary === 'string'
      && write.summary.includes('recreate blew up')
      && (write.payload as Record<string, unknown>)?.reconciledIntentStatus === 'failed',
    )).toBe(true);
    expect(harness.submit).toHaveBeenCalledTimes(2);
  });
});
