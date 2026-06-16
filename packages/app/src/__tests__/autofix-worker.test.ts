import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationIntent } from '@invoker/data-store';

import {
  buildReviewGateCiContext,
  isReviewGateCiCandidateEligible,
  scanAutoFixCandidates,
  startAutoFixWorker,
  type AutoFixCandidate,
  type AutoFixWorkerStateView,
} from '../autofix-worker.js';
import { buildReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    status: 'failed',
    config: { workflowId: 'wf-1' },
    execution: { autoFixAttempts: 0, error: 'boom' },
    ...overrides,
  } as unknown as TaskState;
}

function execIntent(args: unknown[]): WorkflowMutationIntent {
  return {
    channel: 'headless.exec',
    args: [{ args }],
  } as unknown as WorkflowMutationIntent;
}

/** Minimal fake state view backed by a flat task list. */
function makeState(tasks: TaskState[], overrides: Partial<AutoFixWorkerStateView> = {}): AutoFixWorkerStateView {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    getAllTasks: () => tasks,
    getTask: (id) => byId.get(id),
    shouldAutoFix: (id) => {
      const t = byId.get(id);
      return Boolean(t && t.status === 'failed' && (t.execution.autoFixAttempts ?? 0) < 3);
    },
    getAutoFixRetryBudget: () => 3,
    ...overrides,
  };
}

function ciEvent(overrides: Record<string, unknown> = {}) {
  return buildReviewGateCiFailedLifecycleEvent({
    workflowId: 'wf-1',
    taskId: 'wf-1/task-a',
    status: 'review_ready',
    taskStateVersion: 1,
    generation: 2,
    reviewId: 'pr-7',
    reviewUrl: 'https://example/pr/7',
    branch: 'task-a',
    headSha: 'deadbeef',
    failedChecks: [{ name: 'build', conclusion: 'failure', detailsUrl: 'https://ci/1' }],
    statusText: 'CI failed',
    ...overrides,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Pure scan: failed-task auto-fix ──────────────────────────

describe('scanAutoFixCandidates — failed tasks', () => {
  it('builds an --auto-fix command for an eligible failed task', () => {
    const state = makeState([makeTask()]);
    const candidates = scanAutoFixCandidates({
      state,
      openIntents: [],
      reviewGateContexts: new Map(),
      config: { autoFixAgent: 'codex' },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      taskId: 'wf-1/task-a',
      workflowId: 'wf-1',
      source: 'task_failed',
      args: ['fix', 'wf-1/task-a', 'codex', '--auto-fix'],
    });
  });

  it('omits the agent token when no auto-fix agent is configured', () => {
    const candidates = scanAutoFixCandidates({
      state: makeState([makeTask()]),
      openIntents: [],
      reviewGateContexts: new Map(),
      config: {},
    });
    expect(candidates[0]?.args).toEqual(['fix', 'wf-1/task-a', '--auto-fix']);
  });

  it('skips tasks the state deems ineligible for auto-fix', () => {
    const state = makeState([makeTask()], { shouldAutoFix: () => false });
    expect(
      scanAutoFixCandidates({ state, openIntents: [], reviewGateContexts: new Map(), config: {} }),
    ).toEqual([]);
  });

  it('skips user-cancelled/terminated errors', () => {
    const state = makeState([makeTask({ execution: { autoFixAttempts: 0, error: 'Cancelled by user' } } as any)]);
    expect(
      scanAutoFixCandidates({ state, openIntents: [], reviewGateContexts: new Map(), config: {} }),
    ).toEqual([]);
  });

  it('skips a task that already has an open fix intent (headless.exec)', () => {
    const state = makeState([makeTask()]);
    const candidates = scanAutoFixCandidates({
      state,
      openIntents: [execIntent(['fix', 'wf-1/task-a'])],
      reviewGateContexts: new Map(),
      config: {},
    });
    expect(candidates).toEqual([]);
  });

  it('skips a task that has no resolvable workflow id', () => {
    const state = makeState([makeTask({ config: { workflowId: '   ' } } as any)]);
    expect(
      scanAutoFixCandidates({ state, openIntents: [], reviewGateContexts: new Map(), config: {} }),
    ).toEqual([]);
  });
});

// ── Pure scan: review-gate CI failures ───────────────────────

describe('scanAutoFixCandidates — review-gate CI', () => {
  const reviewReadyTask = makeTask({
    status: 'review_ready',
    execution: { autoFixAttempts: 0, generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
  } as any);
  const context = buildReviewGateCiContext(ciEvent(), reviewReadyTask);

  it('builds a fix command carrying the review-gate context when autoFixCi is on', () => {
    const state = makeState([reviewReadyTask]);
    const candidates = scanAutoFixCandidates({
      state,
      openIntents: [],
      reviewGateContexts: new Map([[reviewReadyTask.id, context]]),
      config: { autoFixCi: true },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('review_gate_ci');
    expect(candidates[0]?.args.slice(0, 3)).toEqual(['fix', 'wf-1/task-a', '--auto-fix']);
    expect(candidates[0]?.args).toContain('--review-gate-ci');
    const encoded = candidates[0]?.args[candidates[0].args.indexOf('--review-gate-ci') + 1] ?? '';
    expect(JSON.parse(encoded)).toMatchObject({ reviewId: 'pr-7', generation: 2 });
  });

  it('ignores review-gate CI failures when autoFixCi is disabled', () => {
    const state = makeState([reviewReadyTask]);
    expect(
      scanAutoFixCandidates({
        state,
        openIntents: [],
        reviewGateContexts: new Map([[reviewReadyTask.id, context]]),
        config: { autoFixCi: false },
      }),
    ).toEqual([]);
  });

  it('drops a stale review-gate context (live lineage moved on)', () => {
    const moved = makeTask({
      status: 'review_ready',
      execution: { autoFixAttempts: 0, generation: 9, selectedAttemptId: 'att-2', branch: 'task-a', reviewId: 'pr-7' },
    } as any);
    const state = makeState([moved]);
    expect(
      scanAutoFixCandidates({
        state,
        openIntents: [],
        reviewGateContexts: new Map([[moved.id, context]]),
        config: { autoFixCi: true },
      }),
    ).toEqual([]);
  });

  it('prefers the review-gate candidate over a plain failed-task candidate for the same task', () => {
    const failingReview = makeTask({
      status: 'failed',
      execution: { autoFixAttempts: 0, error: 'boom', generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
    } as any);
    const ctx = buildReviewGateCiContext(ciEvent({ status: 'failed' }), failingReview);
    const state = makeState([failingReview]);
    const candidates = scanAutoFixCandidates({
      state,
      openIntents: [],
      reviewGateContexts: new Map([[failingReview.id, ctx]]),
      config: { autoFixCi: true },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('review_gate_ci');
  });
});

describe('isReviewGateCiCandidateEligible', () => {
  const task = makeTask({
    status: 'review_ready',
    execution: { autoFixAttempts: 0, generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
  } as any);
  const context = buildReviewGateCiContext(ciEvent(), task);

  it('is eligible for a current review_ready task within budget', () => {
    expect(isReviewGateCiCandidateEligible(task, context, makeState([task]))).toBe(true);
  });

  it('is ineligible when the retry budget is exhausted', () => {
    const exhausted = makeTask({
      status: 'review_ready',
      execution: { autoFixAttempts: 3, generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
    } as any);
    expect(isReviewGateCiCandidateEligible(exhausted, context, makeState([exhausted]))).toBe(false);
  });

  it('is ineligible for a status that is not fixable', () => {
    const running = makeTask({ status: 'running' } as any);
    expect(isReviewGateCiCandidateEligible(running, context, makeState([running]))).toBe(false);
  });
});

// ── Integration through the runtime ──────────────────────────

describe('startAutoFixWorker', () => {
  it('submits a fix when a failed-task lifecycle event wakes the worker', async () => {
    const bus = new LocalBus();
    const submitted: AutoFixCandidate[] = [];
    const state = makeState([makeTask()]);

    const worker = startAutoFixWorker({
      messageBus: bus,
      state,
      listOpenFixIntents: () => [],
      config: { autoFixAgent: 'codex' },
      submit: (c) => { submitted.push(c); },
      logger,
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000_000,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, buildReviewGateCiFailedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/other',
      status: 'failed',
      taskStateVersion: 1,
      reviewId: 'pr-x',
      reviewUrl: 'u',
      failedChecks: [],
      statusText: 's',
    }));
    // The failed-task scan still finds the eligible task in state.
    await worker.waitForIdle();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.args).toEqual(['fix', 'wf-1/task-a', 'codex', '--auto-fix']);

    worker.stop();
  });

  it('records review-gate CI context from the event and consumes it after one submit', async () => {
    const bus = new LocalBus();
    const submitted: AutoFixCandidate[] = [];
    const task = makeTask({
      status: 'review_ready',
      execution: { autoFixAttempts: 0, generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
    } as any);
    const state = makeState([task]);

    const worker = startAutoFixWorker({
      messageBus: bus,
      state,
      listOpenFixIntents: () => [],
      config: { autoFixCi: true },
      submit: (c) => { submitted.push(c); },
      logger,
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000_000,
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, ciEvent());
    await worker.waitForIdle();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.source).toBe('review_gate_ci');

    // A second wake must not resubmit: the context was consumed.
    worker.wake();
    await worker.waitForIdle();
    expect(submitted).toHaveLength(1);

    worker.stop();
  });

  it('stops cleanly and detaches its review-gate subscription', async () => {
    const bus = new LocalBus();
    const submitted: AutoFixCandidate[] = [];
    const task = makeTask({
      status: 'review_ready',
      execution: { autoFixAttempts: 0, generation: 2, selectedAttemptId: 'att-1', branch: 'task-a', reviewId: 'pr-7' },
    } as any);

    const worker = startAutoFixWorker({
      messageBus: bus,
      state: makeState([task]),
      listOpenFixIntents: () => [],
      config: { autoFixCi: true },
      submit: (c) => { submitted.push(c); },
      logger,
      scanOnStartup: false,
      handleSignals: false,
      pollIntervalMs: 1_000_000,
    });

    worker.stop();
    expect(worker.isStopped()).toBe(true);

    // Events after stop are ignored.
    bus.publish(Channels.WORKFLOW_LIFECYCLE, ciEvent());
    worker.wake();
    await worker.waitForIdle();
    expect(submitted).toEqual([]);
  });
});
