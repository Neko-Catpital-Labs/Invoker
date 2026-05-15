import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { dispatchStartedTasksWithGlobalTopup, executeGlobalTopup, finalizeMutationWithGlobalTopup } from '../global-topup.js';

function makeTask(id: string, status: TaskState['status'], attemptId?: string): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {
      ...(attemptId ? { selectedAttemptId: attemptId } : {}),
    },
  } as TaskState;
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
}

describe('global-topup helpers', () => {
  it('dispatches scoped started tasks before running global top-up', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const topupTask = makeTask('topup-task', 'running', 'attempt-topup');
    const orchestrator = {
      startExecution: vi.fn().mockReturnValue([scoped, topupTask]),
    };
    const taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: orchestrator as any,
      taskExecutor: taskExecutor as any,
      context: 'test.dispatch',
      started: [scoped],
    });

    expect(taskExecutor.executeTasks).toHaveBeenCalledTimes(2);
    expect(taskExecutor.executeTasks).toHaveBeenNthCalledWith(1, [scoped]);
    expect(taskExecutor.executeTasks).toHaveBeenNthCalledWith(2, [topupTask]);
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([topupTask]);
  });

  it('awaited dispatch waits for executeTasks to finish', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const release = vi.fn();
    let resolveDispatch!: () => void;
    const taskExecutor = {
      executeTasks: vi.fn(() => new Promise<void>((resolve) => {
        resolveDispatch = () => {
          release();
          resolve();
        };
      })),
    };
    const dispatch = dispatchStartedTasksWithGlobalTopup({
      orchestrator: { startExecution: vi.fn().mockReturnValue([]) } as any,
      taskExecutor: taskExecutor as any,
      context: 'test.awaited-dispatch',
      started: [scoped],
    });

    await Promise.resolve();
    let completed = false;
    void dispatch.then(() => { completed = true; });
    await Promise.resolve();

    expect(completed).toBe(false);
    resolveDispatch();
    await dispatch;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fire-and-forget dispatch returns before executeTasks finishes', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const taskExecutor = {
      executeTasks: vi.fn(() => new Promise<void>(() => {})),
    };

    const result = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: { startExecution: vi.fn().mockReturnValue([]) } as any,
      taskExecutor: taskExecutor as any,
      context: 'test.fire-and-forget-dispatch',
      started: [scoped],
      dispatchMode: 'fire-and-forget',
    });

    expect(taskExecutor.executeTasks).toHaveBeenCalledWith([scoped]);
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([]);
  });

  it('fire-and-forget dispatch logs asynchronous executeTasks rejection', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const logger = { error: vi.fn(), info: vi.fn() };
    const taskExecutor = {
      executeTasks: vi.fn().mockRejectedValue(new Error('dispatch failed')),
    };

    await dispatchStartedTasksWithGlobalTopup({
      orchestrator: { startExecution: vi.fn().mockReturnValue([]) } as any,
      taskExecutor: taskExecutor as any,
      logger: logger as any,
      context: 'test.fire-and-forget-rejection',
      started: [scoped],
      dispatchMode: 'fire-and-forget',
    });

    await waitForCondition(() => logger.error.mock.calls.length > 0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('asynchronous task dispatch failed'),
    );
  });

  it('executeGlobalTopup skips tasks already marked as dispatched', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const topupTask = makeTask('topup-task', 'running', 'attempt-topup');
    const orchestrator = {
      startExecution: vi.fn().mockReturnValue([scoped, topupTask]),
    };
    const taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    const topup = await executeGlobalTopup({
      orchestrator: orchestrator as any,
      taskExecutor: taskExecutor as any,
      context: 'test.topup',
      alreadyDispatched: [scoped],
    });

    expect(taskExecutor.executeTasks).toHaveBeenCalledTimes(1);
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith([topupTask]);
    expect(topup).toEqual([topupTask]);
  });

  it('finalizeMutationWithGlobalTopup dispatches started runnable work', async () => {
    const scoped = makeTask('scoped-task', 'running', 'attempt-scoped');
    const orchestrator = {
      startExecution: vi.fn().mockReturnValue([]),
    };
    const taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    const result = await finalizeMutationWithGlobalTopup({
      orchestrator: orchestrator as any,
      taskExecutor: taskExecutor as any,
      context: 'test.finalize',
      started: [scoped],
    });

    expect(taskExecutor.executeTasks).toHaveBeenCalledWith([scoped]);
    expect(result.started).toEqual([scoped]);
    expect(result.topup).toEqual([]);
  });
});
