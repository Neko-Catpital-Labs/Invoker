import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus, type MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import {
  AUTOFIX_WORKER_INTERVAL_ENV,
  DEFAULT_AUTOFIX_WORKER_INTERVAL_MS,
  resolveAutoFixWorkerIntervalMs,
  startAutoFixWorker,
  type AutoFixWorker,
} from '../autofix-worker.js';
import type { DelegationOutcome } from '../headless-delegation.js';
import type { OwnerDiscoveryResult } from '../owner-endpoint.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function makeTask(id: string, status: TaskState['status'], overrides: Partial<TaskState['config']> = {}): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: {
      workflowId: 'wf-1',
      ...overrides,
    },
    execution: {},
    taskStateVersion: 1,
  } as unknown as TaskState;
}

function makeStandaloneOwner(): OwnerDiscoveryResult {
  return { ownerId: 'owner-1', canAcceptStandaloneMutations: true };
}

describe('startAutoFixWorker', () => {
  let worker: AutoFixWorker | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    worker?.stop();
    worker = undefined;
    vi.useRealTimers();
  });

  it('submits a fix request for failed eligible tasks on tick', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async (_args: string[]) => ({ kind: 'delegated' } as DelegationOutcome));
    const discover = vi.fn(async () => makeStandaloneOwner());
    const tasks: TaskState[] = [
      makeTask('wf-1/task-a', 'failed'),
      makeTask('wf-1/task-b', 'completed'),
    ];
    const shouldAutoFix = vi.fn((id: string) => id === 'wf-1/task-a');

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({ autoFixAgent: 'codex' }),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: discover,
    });

    await worker.tick();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(shouldAutoFix).toHaveBeenCalledWith('wf-1/task-a');
    expect(delegateExec).toHaveBeenCalledTimes(1);
    expect(delegateExec).toHaveBeenCalledWith(['fix', 'wf-1/task-a', 'codex', '--auto-fix']);
  });

  it('omits the agent arg when autoFixAgent is unset', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(delegateExec).toHaveBeenCalledWith(['fix', 'wf-1/task-a', '--auto-fix']);
  });

  it('skips submission when no writable owner is reachable', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const discover = vi.fn(async () => null as OwnerDiscoveryResult);
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: discover,
    });

    await worker.tick();

    expect(discover).toHaveBeenCalled();
    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('skips submission when owner is reachable but not standalone-capable', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => ({ ownerId: 'owner-1', canAcceptStandaloneMutations: false }),
    });

    await worker.tick();

    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('skips reconciliation and child tasks before consulting shouldAutoFix', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const shouldAutoFix = vi.fn(() => true);
    const tasks: TaskState[] = [
      makeTask('wf-1/recon', 'failed', { isReconciliation: true } as Partial<TaskState['config']>),
      makeTask('wf-1/child', 'failed', { parentTask: 'wf-1/parent' } as Partial<TaskState['config']>),
      makeTask('wf-1/normal', 'failed'),
    ];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(delegateExec).toHaveBeenCalledTimes(1);
    expect(delegateExec).toHaveBeenCalledWith(['fix', 'wf-1/normal', '--auto-fix']);
  });

  it('wakes on TASK_DELTA failed transitions and re-runs tick', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    let tasks: TaskState[] = [];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    tasks = [makeTask('wf-1/late', 'failed')];
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/late',
      changes: { status: 'failed' },
    } as any);

    await vi.waitFor(() => {
      expect(delegateExec).toHaveBeenCalledWith(['fix', 'wf-1/late', '--auto-fix']);
    });
  });

  it('ignores non-failed TASK_DELTA messages', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const shouldAutoFix = vi.fn(() => true);
    const loadTasks = vi.fn(() => [] as TaskState[]);

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix,
      loadTasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: { status: 'completed' },
    } as any);

    await Promise.resolve();
    await Promise.resolve();

    expect(loadTasks).not.toHaveBeenCalled();
    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('continues after a delegate error', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn()
      .mockRejectedValueOnce(new Error('transport boom'))
      .mockResolvedValue({ kind: 'delegated' } as DelegationOutcome);
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('auto-fix worker submit failed'),
      expect.objectContaining({ module: 'auto-fix-worker' }),
    );

    await worker.tick();
    expect(delegateExec).toHaveBeenCalledTimes(2);
  });

  it('does not run concurrent ticks; coalesces wakeups into a single follow-up', async () => {
    const messageBus = new LocalBus() as MessageBus;
    let resolveFirst!: () => void;
    const blocker = new Promise<DelegationOutcome>((resolve) => {
      resolveFirst = () => resolve({ kind: 'delegated' });
    });
    const delegateExec = vi.fn()
      .mockReturnValueOnce(blocker)
      .mockResolvedValue({ kind: 'delegated' } as DelegationOutcome);
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    const firstTick = worker.tick();
    // Yield until the first tick reaches its blocking delegateExec; tick
    // awaits discover() first, so we need to flush microtasks before we
    // launch the concurrent ticks that should coalesce.
    await vi.waitFor(() => {
      expect(delegateExec).toHaveBeenCalledTimes(1);
    });
    const secondTick = worker.tick();
    const thirdTick = worker.tick();

    // Only the first call to delegate has started; the others coalesce.
    expect(delegateExec).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([firstTick, secondTick, thirdTick]);

    // Exactly one queued retry runs after the first tick finishes, even
    // though two follow-up ticks were requested. The queued tick is
    // fire-and-forget from the finally block, so wait for its delegate
    // call to land before asserting.
    await vi.waitFor(() => {
      expect(delegateExec).toHaveBeenCalledTimes(2);
    });
  });

  it('stops cleanly: clears the interval and unsubscribes', async () => {
    vi.useFakeTimers();
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const loadTasks = vi.fn(() => [] as TaskState[]);

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 1_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    worker.stop();
    expect(worker.isStopped()).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/late',
      changes: { status: 'failed' },
    } as any);
    await Promise.resolve();

    expect(loadTasks).not.toHaveBeenCalled();
    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('submits a fix for a review-gate task with persisted CI failure when autoFixCi is true', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const failedTask = makeTask('wf-1/merge-ci', 'review_ready');
    (failedTask as any).execution = {
      reviewId: '42',
      autoFixAttempts: 0,
      reviewCiFailure: {
        headSha: 'abc',
        statusText: 'CI failed',
        failedChecks: [{ name: 'unit' }],
      },
    };
    const shouldAutoFix = vi.fn(() => false);

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix,
      getAutoFixRetryBudget: () => 3,
      loadTasks: () => [failedTask],
      messageBus,
      loadConfig: () => ({ autoFixCi: true }),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(delegateExec).toHaveBeenCalledWith(['fix', 'wf-1/merge-ci', '--auto-fix']);
    // `shouldAutoFix` only governs the `failed` branch; review-gate eligibility
    // uses `getAutoFixRetryBudget` instead so manual auto-fix attempt budget
    // accounting matches the merge-gate path.
    expect(shouldAutoFix).not.toHaveBeenCalled();
  });

  it('skips review-gate tasks when autoFixCi is false', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const reviewTask = makeTask('wf-1/merge-ci', 'review_ready');
    (reviewTask as any).execution = {
      reviewId: '42',
      reviewCiFailure: {
        headSha: 'abc',
        statusText: 'CI failed',
        failedChecks: [{ name: 'unit' }],
      },
    };

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => false,
      getAutoFixRetryBudget: () => 3,
      loadTasks: () => [reviewTask],
      messageBus,
      loadConfig: () => ({ autoFixCi: false }),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('skips review-gate tasks whose retry budget is already exhausted', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'delegated' } as DelegationOutcome));
    const reviewTask = makeTask('wf-1/merge-ci', 'awaiting_approval');
    (reviewTask as any).execution = {
      reviewId: '42',
      autoFixAttempts: 3,
      reviewCiFailure: {
        headSha: 'abc',
        statusText: 'CI failed',
        failedChecks: [{ name: 'unit' }],
      },
    };

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => false,
      getAutoFixRetryBudget: () => 3,
      loadTasks: () => [reviewTask],
      messageBus,
      loadConfig: () => ({ autoFixCi: true }),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(delegateExec).not.toHaveBeenCalled();
  });

  it('logs a protocol-error outcome at error level', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const delegateExec = vi.fn(async () => ({ kind: 'protocol-error', message: 'bad shape' } as DelegationOutcome));
    const tasks: TaskState[] = [makeTask('wf-1/task-a', 'failed')];

    worker = startAutoFixWorker({
      logger,
      shouldAutoFix: () => true,
      loadTasks: () => tasks,
      messageBus,
      loadConfig: () => ({}),
      intervalMs: 60_000,
      delegateExec,
      discoverOwner: async () => makeStandaloneOwner(),
    });

    await worker.tick();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('protocol error'),
      expect.objectContaining({ module: 'auto-fix-worker' }),
    );
  });
});

describe('resolveAutoFixWorkerIntervalMs', () => {
  it('returns the default when env var is absent', () => {
    expect(resolveAutoFixWorkerIntervalMs({})).toBe(DEFAULT_AUTOFIX_WORKER_INTERVAL_MS);
  });

  it('returns the parsed override within bounds', () => {
    expect(
      resolveAutoFixWorkerIntervalMs({ [AUTOFIX_WORKER_INTERVAL_ENV]: '2500' }),
    ).toBe(2500);
  });

  it('clamps very small values to a sane minimum', () => {
    expect(
      resolveAutoFixWorkerIntervalMs({ [AUTOFIX_WORKER_INTERVAL_ENV]: '5' }),
    ).toBeGreaterThanOrEqual(250);
  });

  it('falls back to default for non-numeric env values', () => {
    expect(
      resolveAutoFixWorkerIntervalMs({ [AUTOFIX_WORKER_INTERVAL_ENV]: 'not-a-number' }),
    ).toBe(DEFAULT_AUTOFIX_WORKER_INTERVAL_MS);
  });
});
