import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationIntent } from '@invoker/data-store';

import {
  buildReviewGateCiFailedLifecycleEvent,
  buildTaskUpdatedLifecycleEvent,
} from '../lifecycle-events.js';
import { parseHeadlessFixArgs } from '../auto-fix-intents.js';
import {
  buildAutoFixCommandArgs,
  scanAutoFixCandidates,
  startAutoFixWorker,
} from '../autofix-worker.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-a',
    description: 'Task A',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-06-04T00:00:00.000Z'),
    taskStateVersion: 3,
    ...rest,
    config: {
      workflowId: 'wf-1',
      ...config,
    },
    execution: {
      autoFixAttempts: 0,
      error: 'boom',
      generation: 1,
      selectedAttemptId: 'attempt-1',
      ...execution,
    },
  } as TaskState;
}

function makeIntent(overrides: Partial<WorkflowMutationIntent>): WorkflowMutationIntent {
  return {
    id: 1,
    workflowId: 'wf-1',
    channel: 'headless.exec',
    args: [{ args: ['fix', 'wf-1/task-a', 'codex'] }],
    priority: 'normal',
    status: 'queued',
    createdAt: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };
}

function makePersistence(tasks: TaskState[], intents: WorkflowMutationIntent[] = []) {
  return {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn(() => tasks),
    listWorkflowMutationIntents: vi.fn(() => intents),
    enqueueWorkflowMutationIntent: vi.fn(() => 1),
  };
}

describe('autofix-worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('submits eligible failed tasks through the normal headless fix route on lifecycle wakeup', async () => {
    const bus = new LocalBus();
    const submitFixCommand = vi.fn(async () => undefined);
    const persistence = makePersistence([makeTask()]);
    const worker = startAutoFixWorker({
      logger,
      messageBus: bus,
      persistence,
      orchestrator: { syncFromDb: vi.fn() },
      getConfig: () => ({ autoFixRetries: 2, autoFixAgent: 'codex' } as any),
      submitFixCommand,
      pollIntervalMs: 0,
      startImmediately: false,
      signalNames: [],
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 3,
      generation: 1,
      createdAt: '2026-06-04T00:00:00.000Z',
    }));
    await worker.waitForIdle();

    expect(submitFixCommand).toHaveBeenCalledWith(
      ['fix', 'wf-1/task-a', 'codex', '--auto-fix'],
      expect.objectContaining({
        candidate: expect.objectContaining({ taskId: 'wf-1/task-a' }),
        trigger: expect.objectContaining({ kind: 'lifecycle' }),
      }),
    );

    await worker.stop();
  });

  it('recovers missed lifecycle events by polling persisted tasks', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const submitFixCommand = vi.fn(async () => undefined);
    const worker = startAutoFixWorker({
      logger,
      messageBus: bus,
      persistence: makePersistence([makeTask()]),
      getConfig: () => ({ autoFixRetries: 2, autoFixAgent: 'claude' } as any),
      submitFixCommand,
      pollIntervalMs: 1000,
      startImmediately: false,
      signalNames: [],
    });

    await vi.advanceTimersByTimeAsync(1000);
    await worker.waitForIdle();

    expect(submitFixCommand).toHaveBeenCalledWith(
      ['fix', 'wf-1/task-a', 'claude', '--auto-fix'],
      expect.objectContaining({
        trigger: expect.objectContaining({ kind: 'poll' }),
      }),
    );

    await worker.stop();
  });

  it('preserves review-gate CI context when submitting a lifecycle-triggered fix', async () => {
    const task = makeTask({
      status: 'review_ready',
      execution: {
        autoFixAttempts: 0,
        generation: 2,
        selectedAttemptId: 'attempt-2',
        reviewId: 'owner/repo#12',
        branch: 'feature/task-a',
      },
    });
    const bus = new LocalBus();
    const submitFixCommand = vi.fn(async () => undefined);
    const worker = startAutoFixWorker({
      logger,
      messageBus: bus,
      persistence: makePersistence([task]),
      getConfig: () => ({ autoFixRetries: 2, autoFixAgent: 'codex', autoFixCi: true } as any),
      submitFixCommand,
      pollIntervalMs: 0,
      startImmediately: false,
      signalNames: [],
    });

    bus.publish(Channels.WORKFLOW_LIFECYCLE, buildReviewGateCiFailedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'review_ready',
      taskStateVersion: 4,
      reviewId: 'owner/repo#12',
      reviewUrl: 'https://github.test/owner/repo/pull/12',
      branch: 'feature/task-a',
      generation: 2,
      attemptId: 'attempt-2',
      failedChecks: [{ name: 'test', conclusion: 'failure', detailsUrl: 'https://ci.test/log' }],
      statusText: 'CI failed',
      createdAt: '2026-06-04T00:00:00.000Z',
    }));
    await worker.waitForIdle();

    const args = submitFixCommand.mock.calls[0]?.[0] as string[];
    expect(args[0]).toBe('fix');
    expect(args).toContain('--auto-fix');
    expect(parseHeadlessFixArgs(args)).toMatchObject({
      taskId: 'wf-1/task-a',
      agentName: 'codex',
      autoFix: true,
      reviewGate: {
        reviewId: 'owner/repo#12',
        statusText: 'CI failed',
        failedChecks: [expect.objectContaining({ name: 'test' })],
      },
    });

    await worker.stop();
  });

  it('falls back to a persisted headless fix intent when no owner is reachable', async () => {
    const bus = new LocalBus();
    const persistence = makePersistence([makeTask()]);
    const worker = startAutoFixWorker({
      logger,
      messageBus: bus,
      persistence,
      getConfig: () => ({ autoFixRetries: 2, autoFixAgent: 'codex' } as any),
      pollIntervalMs: 0,
      startImmediately: false,
      signalNames: [],
    });

    await worker.wake('test');

    expect(persistence.enqueueWorkflowMutationIntent).toHaveBeenCalledWith(
      'wf-1',
      'headless.exec',
      [{ args: ['fix', 'wf-1/task-a', 'codex', '--auto-fix'], waitForApproval: false, noTrack: true }],
      'normal',
    );

    await worker.stop();
  });

  it('does not submit duplicate auto-fix work while a manual fix intent is open', () => {
    const candidates = scanAutoFixCandidates({
      logger,
      persistence: makePersistence([makeTask()], [
        makeIntent({
          channel: 'headless.exec',
          args: [{ args: ['fix', 'wf-1/task-a', 'claude'] }],
          status: 'running',
        }),
      ]),
      getConfig: () => ({ autoFixRetries: 2, autoFixAgent: 'codex' } as any),
    }, {
      workerName: 'autofix',
      trigger: { kind: 'poll', at: new Date('2026-06-04T00:00:00.000Z') },
    });

    expect(candidates).toEqual([]);
  });

  it('keeps manual fix attempts out of the auto-fix retry budget', () => {
    const candidates = scanAutoFixCandidates({
      logger,
      persistence: makePersistence([makeTask({
        execution: {
          error: 'boom after an operator-triggered Fix with AI',
          autoFixAttempts: 0,
          generation: 1,
          selectedAttemptId: 'attempt-1',
        },
      })]),
      getConfig: () => ({ autoFixRetries: 1, autoFixAgent: 'codex' } as any),
    }, {
      workerName: 'autofix',
      trigger: { kind: 'poll', at: new Date('2026-06-04T00:00:00.000Z') },
    });

    expect(candidates).toEqual([
      {
        workflowId: 'wf-1',
        taskId: 'wf-1/task-a',
        agentName: 'codex',
      },
    ]);
  });

  it('builds normal fix commands without direct execution APIs', () => {
    expect(buildAutoFixCommandArgs({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      agentName: 'codex',
    })).toEqual(['fix', 'wf-1/task-a', 'codex', '--auto-fix']);
  });
});
