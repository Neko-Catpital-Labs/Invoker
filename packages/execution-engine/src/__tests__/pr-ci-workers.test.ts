import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  autoFixAttemptLedgerKeyFromLifecycleEvent,
  createAutoFixAttemptLedger,
} from '../auto-fix-attempt-ledger.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  ciFailureActionKey,
  queueReviewGateCiRepair,
  SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
} from '../review-gate-ci-repair.js';
import { maybePublishReviewGateCiFailure } from '../task-runner-review-gate.js';
import {
  DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
  createPrStatusWorker,
} from '../workers/pr-status-worker.js';

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
      ...(execution ?? {}),
    },
    taskStateVersion: 10,
    ...rest,
  } as TaskState;
}

function makeEvent(overrides: Partial<ReviewGateCiFailedLifecycleEvent> = {}): ReviewGateCiFailedLifecycleEvent {
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
      { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
      { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
    ],
    statusText: 'CI failed',
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

function makeRepairHarness(task = makeTask()) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string, _args: unknown[]) => 42);
  const store = {
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const attemptLedger = createAutoFixAttemptLedger();
  return { actions, store, submit, attemptLedger };
}

describe('PR status worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls review-gate status on the 60000ms default interval', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);
    const worker = createPrStatusWorker({
      logger,
      reviewGate: { checkMergeGateStatuses },
      installSignalHandlers: false,
    });

    worker.start();
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_PR_STATUS_WORKER_INTERVAL_MS);

    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('records failed CI repair submission without burning the in-memory retry budget', async () => {
    const event = makeEvent();
    const harness = makeRepairHarness();
    harness.submit
      .mockImplementationOnce(() => {
        throw new Error('submit blew up');
      })
      .mockImplementation(() => 42);
    const policy = {
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 1,
    };
    const actionKey = `ci-failure:${ciFailureActionKey(event)}`;

    await expect(queueReviewGateCiRepair(policy, event)).resolves.toMatchObject({
      decision: 'failed',
      reason: 'submit-failed',
    });

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.actions.get(actionKey)).toMatchObject({
      status: 'failed',
      summary: 'Failed to queue CI repair workflow',
      payload: expect.objectContaining({
        reason: 'submit-failed',
        error: 'submit blew up',
        channel: SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
        workerRetryBudget: 1,
      }),
    });
    expect(harness.attemptLedger.get(autoFixAttemptLedgerKeyFromLifecycleEvent(event))).toBe(0);

    await expect(queueReviewGateCiRepair(policy, event)).resolves.toMatchObject({
      decision: 'queued',
      reason: 'queued',
      intentId: 42,
    });

    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect(harness.actions.get(actionKey)).toMatchObject({
      status: 'queued',
      summary: 'Queued CI repair workflow',
      attemptCount: 1,
      intentId: '42',
      payload: expect.objectContaining({
        channel: SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
        workerRetryBudget: 1,
      }),
    });
  });

  it('does not publish a CI repair intent for pending checks or merge-conflict-only polls', async () => {
    const publish = vi.fn();
    const host = {
      reviewGateCiFailurePublisher: { publish },
      reviewGateCiFailureInFlight: new Set<string>(),
    } as any;
    const task = makeTask();

    await maybePublishReviewGateCiFailure(host, task, {
      lifecycle: 'open',
      rejected: false,
      statusText: 'Checks pending',
      url: 'https://github.com/owner/repo/pull/123',
      checks: { state: 'pending', failed: [] },
    }, '123');
    await maybePublishReviewGateCiFailure(host, task, {
      lifecycle: 'open',
      rejected: false,
      statusText: 'Merge conflict',
      url: 'https://github.com/owner/repo/pull/123',
      mergeState: 'dirty',
    }, '123');

    expect(publish).not.toHaveBeenCalled();
  });
});
