import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import { createAutoFixRecoveryTick } from '../worker-runtime.js';
import { buildFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { RecoveryWorkerWakeupHint } from '../lifecycle-events.js';

describe('wireHeadlessAutoFix', () => {
  it('subscribes auto-fix for failed deltas in generic headless execution paths', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const shouldAutoFix = vi.fn((taskId: string) => taskId === 'wf-1/task-1');
    const invokeAutoFix = vi.fn(async () => {});
    const onError = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix } as any,
        persistence: {} as any,
      },
      {} as any,
      invokeAutoFix,
      onError,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(shouldAutoFix).toHaveBeenCalledWith('wf-1/task-1');
    expect(shouldAutoFix).toHaveBeenCalledWith('wf-1/task-2');
    expect(invokeAutoFix).toHaveBeenCalledTimes(1);
    expect(invokeAutoFix).toHaveBeenCalledWith('wf-1/task-1');
    expect(onError).not.toHaveBeenCalled();
  });
});

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

function makeRecoveryHarness(task: TaskState = makeTask(), consumeWakeups?: () => RecoveryWorkerWakeupHint[]) {
  const workflows = [{ id: 'wf-1' }];
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const intents: WorkflowMutationIntent[] = [];
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
  const tick = createAutoFixRecoveryTick({
    persistence: {
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
    defaultAutoFixRetries: 3,
    getAutoFixAgent: () => 'codex',
    ...(consumeWakeups ? { consumeWakeups } : {}),
  });
  return { tick, submit, logEvent, tasks, intents };
}

describe('auto-fix recovery worker policy', () => {
  it('submits eligible failed tasks discovered by the startup scan through the command route', async () => {
    const { tick, submit } = makeRecoveryHarness();

    await tick({
      identity: { kind: 'recovery', instanceId: 'test' },
      reason: 'startup',
      tickNumber: 1,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true }),
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
    const harness = makeRecoveryHarness(makeTask(), () => [wakeup, wakeup]);

    await harness.tick({
      identity: { kind: 'recovery', instanceId: 'test' },
      reason: 'wake',
      tickNumber: 1,
    });

    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('skips stale generation wakeups without submitting a command', async () => {
    const task = makeTask({ execution: { error: 'boom', autoFixAttempts: 0, generation: 2, selectedAttemptId: 'attempt-2' } });
    const harness = makeRecoveryHarness(task);
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
    const tick = createAutoFixRecoveryTick({
      persistence: {
        listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
        loadTasks: vi.fn(() => [task]),
        loadTask: vi.fn(() => task),
        listWorkflowMutationIntents: vi.fn(() => []),
        logEvent: harness.logEvent,
      },
      submitter: { submit: harness.submit },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
      defaultAutoFixRetries: 3,
      consumeWakeups: () => [wakeup],
    });

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
