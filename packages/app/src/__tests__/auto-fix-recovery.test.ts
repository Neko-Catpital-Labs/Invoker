import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskState } from '@invoker/workflow-core';

import {
  createRecoveryWorker,
  listAutoFixRecoveryScanCandidates,
  RECOVERY_WORKER_KIND,
} from '../workers/auto-fix-recovery.js';

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
