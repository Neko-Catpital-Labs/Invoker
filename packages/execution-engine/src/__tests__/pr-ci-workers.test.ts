import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  buildReviewGateCiRepairWorkflowMutationArgs,
  parseReviewGateCiRepairWorkflowMutationArgs,
  SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
} from '../review-gate-ci-repair.js';
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
import { maybePublishReviewGateCiFailure } from '../task-runner-review-gate.js';
import {
  DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
  createPrStatusWorker,
} from '../workers/pr-status-worker.js';
import { PR_5188_INFRA_LOG } from './fixtures/pr-5188-infra-ci-log.js';

const CODE_FAILURE_LOG = `
FAIL src/example.test.ts > does the thing
AssertionError: expected 1 to be 2
`;


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
    expect(channel).toBe(SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL);
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

  it('queues a head-SHA guarded CI repair workflow intent and records its dedupe action', async () => {
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
      getAutoFixPoolId: () => 'remote_digital_ocean_1',
      drainEvents: () => [event],
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(ciFailureActionKey(sameChecksDifferentOrder)).toBe(ciFailureActionKey(event));
    expect(harness.submit).toHaveBeenCalledTimes(1);
    const [, , , args] = harness.submit.mock.calls[0];
    const parsed = parseReviewGateCiRepairWorkflowMutationArgs(args);
    expect(parsed).toEqual(buildReviewGateCiRepairWorkflowMutationArgs({
      sourceWorkflowId: 'wf-1',
      sourceTaskId: 'wf-1/merge',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'sha-1',
      headRef: 'feature/ci',
      branch: 'feature/ci',
      generation: 2,
      selectedAttemptId: 'attempt-1',
      failedChecks: [
        { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
        { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
      ],
      statusText: 'CI failed',
      taskStateVersion: 10,
      agentName: 'codex',
      executionModel: 'openai/gpt-5.2',
      poolId: 'remote_digital_ocean_1',
    })[0]);
    expect(harness.actions.get(`${CI_FAILURE_WORKER_KIND}:${ciFailureActionKey(event)}`)).toMatchObject({
      workerKind: CI_FAILURE_WORKER_KIND,
      actionType: 'fix-ci-failure',
      status: 'queued',
      summary: 'Queued CI repair workflow',
      intentId: '42',
      externalKey: ciFailureActionKey(event),
      payload: expect.objectContaining({
        channel: SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
      }),
    });
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

  it('skips fix-with-agent for PR #5188-shaped infra checkout failures', async () => {
    const event = makeEvent({
      failedChecks: [
        {
          name: 'PR Body',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090425/job/88290047072',
        },
        {
          name: 'quality / Dependency Cruise',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090393/job/88290047107',
        },
        {
          name: 'quality / Release Version Sync',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090393/job/88290047118',
        },
      ],
      reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/5188',
    });
    const harness = makeHarness();
    const ledgerKey = autoFixAttemptLedgerKeyFromLifecycleEvent(event);
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      drainEvents: () => [event],
      fetchFailedCheckLogs: async (checks) => {
        const logs = new Map<string, string>();
        for (const check of checks) {
          if (check.detailsUrl) logs.set(check.detailsUrl, PR_5188_INFRA_LOG);
        }
        return logs;
      },
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.attemptLedger.get(ledgerKey)).toBe(0);
    expect(harness.actions.get(`${CI_FAILURE_WORKER_KIND}:${ciFailureActionKey(event)}`)).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({
        reason: 'infra-failure',
      }),
    });
  });

  it('still queues fix-with-agent when fetched logs look like code failures', async () => {
    const event = makeEvent({
      failedChecks: [
        {
          name: 'unit',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/owner/repo/actions/runs/1/job/2',
        },
      ],
    });
    const harness = makeHarness();
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      drainEvents: () => [event],
      fetchFailedCheckLogs: async () => new Map([
        ['https://github.com/owner/repo/actions/runs/1/job/2', CODE_FAILURE_LOG],
      ]),
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('fails open and queues repair when log fetch returns nothing', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    const tick = createCiFailureTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      drainEvents: () => [event],
      fetchFailedCheckLogs: async () => new Map(),
    });

    await tick({ identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });
});
