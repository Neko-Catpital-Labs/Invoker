import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { parseFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import {
  autoFixAttemptLedgerKeyFromLifecycleEvent,
  createAutoFixAttemptLedger,
} from '../auto-fix-attempt-ledger.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  CI_FAILURE_WORKER_KIND,
  ciFailureActionKey,
  createCiFailureTick,
} from '../workers/ci-failure-worker.js';
import {
  maybePublishReviewGateCiFailure,
  pollMergeGateTask,
} from '../task-runner-review-gate.js';
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

function makeHarness(task = makeTask()) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:fix-with-agent');
    expect(args).toBeDefined();
    return 42;
  });
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
function makeMergeConflictPublisherHarness(
  status: {
    lifecycle: 'open' | 'closed' | 'merged';
    rejected: boolean;
    statusText: string;
    url: string;
    headSha?: string;
    headRef?: string;
    mergeState?: 'clean' | 'dirty' | 'unknown';
    hasMergeConflict?: boolean;
    checks?: { state: 'pending' | 'success' | 'failure'; failed: Array<{ name: string; conclusion: string; detailsUrl?: string }> };
  },
  task = makeTask(),
) {
  const publishCi = vi.fn();
  const publishMergeConflict = vi.fn();
  const host = {
    cwd: '/repo',
    logger,
    executeTasks: vi.fn(),
    persistence: {
      updateTask: vi.fn(),
    },
    orchestrator: {
      getTask: vi.fn(() => task),
      recordTaskHeartbeat: vi.fn(),
    },
    mergeGateProvider: {
      checkApproval: vi.fn(async () => status),
    },
    reviewGateCiFailurePublisher: { publish: publishCi },
    reviewGateCiFailureInFlight: new Set<string>(),
    reviewGateMergeConflictPublisher: { publish: publishMergeConflict },
    reviewGateMergeConflictInFlight: new Set<string>(),
  } as any;
  return { host, publishCi, publishMergeConflict };
}

describe('PR status and CI failure workers', () => {
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

  it('queues a head-SHA guarded CI repair intent and records its dedupe action', async () => {
    const event = makeEvent({
      failedChecks: [
        { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
        { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
      ],
    });
    const sameChecksDifferentOrder = makeEvent({
      failedChecks: [...event.failedChecks].reverse(),
    });
    const harness = makeHarness();
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      getAutoFixExecutionModel: () => 'openai/gpt-5.2',
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(ciFailureActionKey(sameChecksDifferentOrder)).toBe(ciFailureActionKey(event));
    expect(harness.submit).toHaveBeenCalledTimes(1);
    const [, , , args] = harness.submit.mock.calls[0];
    const parsed = parseFixWithAgentMutationArgs(args);
    expect(parsed).toMatchObject({
      taskId: 'wf-1/merge',
      agentName: 'codex',
      context: {
        autoFix: true,
        executionModel: 'openai/gpt-5.2',
        reviewGateContext: {
          reviewId: '123',
          generation: 2,
          selectedAttemptId: 'attempt-1',
          headSha: 'sha-1',
        },
      },
    });
    expect(harness.actions.get(`${CI_FAILURE_WORKER_KIND}:${ciFailureActionKey(event)}`)).toMatchObject({
      workerKind: CI_FAILURE_WORKER_KIND,
      actionType: 'fix-ci-failure',
      status: 'queued',
      intentId: '42',
      externalKey: ciFailureActionKey(event),
    });
  });

  it('publishes only the CI repair event for open reviews with failing checks', async () => {
    const task = makeTask();
    const { host, publishCi, publishMergeConflict } = makeMergeConflictPublisherHarness({
      lifecycle: 'open',
      rejected: false,
      statusText: 'CI failed',
      url: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      headRef: 'feature/ci',
      checks: {
        state: 'failure',
        failed: [{ name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' }],
      },
      hasMergeConflict: false,
      mergeState: 'clean',
    }, task);

    await pollMergeGateTask(host, task, 'refresh');

    expect(publishCi).toHaveBeenCalledTimes(1);
    expect(publishCi).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'wf-1/merge',
      workflowId: 'wf-1',
      reviewId: '123',
      failedChecks: [{ name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' }],
    }));
    expect(publishMergeConflict).not.toHaveBeenCalled();
  });

  it.fails('publishes only the merge-conflict repair event for actionable review conflicts', async () => {
    const task = makeTask();
    const { host, publishCi, publishMergeConflict } = makeMergeConflictPublisherHarness({
      lifecycle: 'open',
      rejected: false,
      statusText: 'Merge conflict',
      url: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      headRef: 'feature/ci',
      mergeState: 'dirty',
      hasMergeConflict: true,
    }, task);

    await pollMergeGateTask(host, task, 'refresh');

    expect(publishCi).not.toHaveBeenCalled();
    expect(publishMergeConflict).toHaveBeenCalledTimes(1);
    expect(publishMergeConflict).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'wf-1/merge',
      workflowId: 'wf-1',
      reviewId: '123',
      status: 'review_ready',
      taskStateVersion: 10,
      statusText: 'Merge conflict',
    }));
  });

  it('does not publish a merge-conflict repair for BEHIND review status', async () => {
    const task = makeTask();
    const { host, publishCi, publishMergeConflict } = makeMergeConflictPublisherHarness({
      lifecycle: 'open',
      rejected: false,
      statusText: 'Branch is behind base',
      url: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      headRef: 'feature/ci',
      mergeState: 'dirty',
      hasMergeConflict: false,
    }, task);

    await pollMergeGateTask(host, task, 'refresh');

    expect(publishCi).not.toHaveBeenCalled();
    expect(publishMergeConflict).not.toHaveBeenCalled();
  });

  it('queues CI repair while the in-memory retry budget allows it', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('skips CI repair once the in-memory retry budget is exhausted', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    harness.attemptLedger.consume(autoFixAttemptLedgerKeyFromLifecycleEvent(event), 1);
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 1,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.actions.get(`${CI_FAILURE_WORKER_KIND}:${ciFailureActionKey(event)}`)).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({
        reason: 'worker-retry-budget-exhausted',
        workerRetryBudget: 1,
      }),
    });
  });

  it('rejects stale CI failure events when the PR head changed before submit', async () => {
    const event = makeEvent();
    const task = makeTask({
      execution: {
        reviewGate: {
          activeGeneration: 2,
          completion: { required: 'all', status: 'approved' },
          artifacts: [{
            id: 'pr-123',
            providerId: '123',
            required: true,
            status: 'open',
            generation: 2,
            headSha: 'sha-2',
          }],
        },
      },
    });
    const harness = makeHarness(task);
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
      attemptLedger: harness.attemptLedger,
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).not.toHaveBeenCalled();
    // Stale events are routine scan noise: logged, but NOT recorded as a durable
    // decision row. Only meaningful skips (e.g. retry-budget-exhausted) persist.
    expect(harness.actions.get(`${CI_FAILURE_WORKER_KIND}:${ciFailureActionKey(event)}`)).toBeUndefined();
    expect(harness.store.upsertWorkerAction).not.toHaveBeenCalled();
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
