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
