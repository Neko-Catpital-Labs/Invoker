import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { buildFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import {
  collectValidatedAutoFixRecoveryCandidates,
  createAutoFixRecoveryTick,
  createRecoveryWorker,
  listAutoFixRecoveryScanCandidates,
  RECOVERY_WORKER_KIND,
} from '../workers/auto-fix-recovery.js';
import type { RecoveryWorkerWakeupHint } from '../lifecycle-events.js';

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
    id: 'wf-1/task-1',
    description: 'failed task',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', ...(config ?? {}) },
    execution: {
      error: 'boom',
      autoFixAttempts: 0,
      generation: 1,
      selectedAttemptId: 'attempt-1',
      ...(execution ?? {}),
    },
    taskStateVersion: 4,
    ...rest,
  };
}

function makeRecoveryPolicyHarness(
  task: TaskState = makeTask(),
  existingIntents: WorkflowMutationIntent[] = [],
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[],
) {
  const workflows = [{ id: 'wf-1' }];
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const intents: WorkflowMutationIntent[] = [...existingIntents];
  const logEvent = vi.fn();
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    const id = intents.length + 1;
    intents.push({
      id,
      workflowId,
      priority,
      channel,
      args,
      status: 'queued',
      createdAt: new Date().toISOString(),
    });
    return id;
  });
  const options = {
    store: {
      listWorkflows: vi.fn(() => workflows),
      loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
      loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
      listWorkflowMutationIntents: vi.fn((workflowId?: string, statuses?: string[]) => intents.filter((intent) => (
        (!workflowId || intent.workflowId === workflowId)
        && (!statuses || statuses.includes(intent.status))
      ))),
      logEvent,
    },
    submitter: { submit },
    logger,
    defaultAutoFixRetries: 3,
    getAutoFixAgent: () => 'codex',
    ...(drainWakeupHints ? { drainWakeupHints } : {}),
  };
  return { options, submit, logEvent, tasks, intents };
}

describe('auto-fix recovery worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('exposes the recovery identity', () => {
    const runtime = createRecoveryWorker({ logger, instanceId: 'rec-1', installSignalHandlers: false });
    expect(runtime.identity).toEqual({ kind: RECOVERY_WORKER_KIND, instanceId: 'rec-1' });
  });

  it('is behavior-neutral: its default tick does nothing and does not throw', async () => {
    const runtime = createRecoveryWorker({ logger, instanceId: 'rec-2', installSignalHandlers: false });
    await expect(runtime.tick()).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('does not auto-run a tick on start', async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const runtime = createRecoveryWorker({
      logger,
      instanceId: 'rec-3',
      intervalMs: 1000,
      onTick,
      installSignalHandlers: false,
    });
    runtime.start();
    await Promise.resolve();
    // tickOnStart defaults to false for the recovery worker.
    expect(onTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});

describe('auto-fix recovery scan candidates', () => {
  it('lists failed persisted tasks with version metadata', () => {
    const failedTask = makeTask();
    const completedTask = makeTask({ id: 'wf-1/task-2', status: 'completed' });

    const candidates = listAutoFixRecoveryScanCandidates({
      store: {
        listWorkflows: () => [{ id: 'wf-1' }],
        loadTasks: () => [failedTask, completedTask],
        listWorkflowMutationIntents: () => [],
      },
    });

    expect(candidates).toEqual([
      {
        taskId: 'wf-1/task-1',
        workflowId: 'wf-1',
        generation: 1,
        taskStateVersion: 4,
        attemptId: 'attempt-1',
        source: 'scan',
      },
    ]);
  });
});

describe('auto-fix recovery candidate validation', () => {
  it('accepts eligible scan candidates after reloading current task state', () => {
    const harness = makeRecoveryPolicyHarness();

    const candidates = collectValidatedAutoFixRecoveryCandidates(harness.options);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      taskId: 'wf-1/task-1',
      workflowId: 'wf-1',
      generation: 1,
      taskStateVersion: 4,
      source: 'scan',
      task: expect.objectContaining({ id: 'wf-1/task-1' }),
    });
  });

  it.each([
    {
      name: 'workflow',
      task: makeTask({ config: { workflowId: 'wf-2' } }),
      reason: 'stale-workflow',
      details: { latestWorkflowId: 'wf-2' },
    },
    {
      name: 'generation',
      task: makeTask({ execution: { error: 'boom', autoFixAttempts: 0, generation: 2, selectedAttemptId: 'attempt-1' } }),
      reason: 'stale-generation',
      details: { latestGeneration: 2 },
    },
    {
      name: 'task-state version',
      task: makeTask({ taskStateVersion: 5 }),
      reason: 'stale-task-state-version',
      details: { latestTaskStateVersion: 5 },
    },
    {
      name: 'attempt',
      task: makeTask({ execution: { error: 'boom', autoFixAttempts: 0, generation: 1, selectedAttemptId: 'attempt-2' } }),
      reason: 'stale-attempt',
      details: { latestAttemptId: 'attempt-2' },
    },
  ])('skips stale $name candidates before eligibility checks', ({ task, reason, details }) => {
    const harness = makeRecoveryPolicyHarness(task);

    const candidates = collectValidatedAutoFixRecoveryCandidates(harness.options, [
      {
        taskId: 'wf-1/task-1',
        workflowId: 'wf-1',
        generation: 1,
        taskStateVersion: 4,
        attemptId: 'attempt-1',
        source: 'scan',
      },
    ]);

    expect(candidates).toHaveLength(0);
    expect(harness.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'worker-autofix-skip',
        reason,
        ...details,
      }),
    );
  });

  it('skips failed tasks that already have an open fix intent', () => {
    const existingIntent: WorkflowMutationIntent = {
      id: 1,
      workflowId: 'wf-1',
      priority: 'normal',
      channel: 'invoker:fix-with-agent',
      args: buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true }),
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    const harness = makeRecoveryPolicyHarness(makeTask(), [existingIntent]);

    const candidates = collectValidatedAutoFixRecoveryCandidates(harness.options);

    expect(candidates).toHaveLength(0);
    expect(harness.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'worker-autofix-skip',
        reason: 'already-queued-intent',
      }),
    );
  });

  it('deduplicates repeated wakeups for the same failed task', async () => {
    const wakeup = {
      eventKey: 'event-1',
      eventKind: 'task.failed' as const,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      taskStateVersion: 4,
      generation: 1,
      attemptId: 'attempt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      reason: 'task_failure' as const,
      authoritative: false as const,
    };
    const harness = makeRecoveryPolicyHarness(makeTask(), [], () => [wakeup, wakeup]);
    const tick = createAutoFixRecoveryTick(harness.options);

    await tick({
      identity: { kind: 'recovery', instanceId: 'test' },
      reason: 'wake',
      tickNumber: 1,
    });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('skips stale generation wakeups without submitting a command', async () => {
    const task = makeTask({ execution: { error: 'boom', autoFixAttempts: 0, generation: 2, selectedAttemptId: 'attempt-2' } });
    const wakeup = {
      eventKey: 'event-old',
      eventKind: 'task.failed' as const,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      taskStateVersion: 4,
      generation: 1,
      attemptId: 'attempt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      reason: 'task_failure' as const,
      authoritative: false as const,
    };
    const harness = makeRecoveryPolicyHarness(task, [], () => [wakeup]);
    const tick = createAutoFixRecoveryTick(harness.options);

    await tick({
      identity: { kind: 'recovery', instanceId: 'test' },
      reason: 'wake',
      tickNumber: 1,
    });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'worker-autofix-skip',
        reason: 'stale-generation',
        latestGeneration: 2,
      }),
    );
  });
});

describe('auto-fix recovery scan submission', () => {
  it('submits eligible failed tasks through the command route', async () => {
    const harness = makeRecoveryPolicyHarness();
    const tick = createAutoFixRecoveryTick(harness.options);

    await tick({
      identity: { kind: 'recovery', instanceId: 'test' },
      reason: 'startup',
      tickNumber: 1,
    });

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true }),
    );
  });
});
