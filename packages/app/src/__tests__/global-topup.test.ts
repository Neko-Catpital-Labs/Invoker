import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { dispatchStartedTasksWithGlobalTopup, executeGlobalTopup, finalizeMutationWithGlobalTopup } from '../global-topup.js';

function makeTask(
  id: string,
  status: TaskState['status'],
  attemptId?: string,
  workflowId = 'wf-1',
): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId },
    execution: {
      ...(attemptId ? { selectedAttemptId: attemptId } : {}),
    },
  } as TaskState;
}


describe('global-topup helpers', () => {
  it('keeps cross-workflow prestarted tasks in top-up when a workflow scope is explicit', async () => {
    const scoped = makeTask('wf-1/task-a', 'running', 'attempt-a', 'wf-1');
    const crossWorkflow = makeTask('wf-2/task-b', 'running', 'attempt-b', 'wf-2');
    const orchestrator = {
      startExecution: vi.fn().mockReturnValue([]),
    };
    const taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: orchestrator as any,
      taskExecutor: taskExecutor as any,
      context: 'test.dispatch-scoped-workflow',
      started: [scoped, crossWorkflow],
      scopedWorkflowId: 'wf-1',
    });

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([crossWorkflow]);
  });

  it('dedupes scoped and prestarted top-up tasks before additional global top-up', async () => {
    const scoped = makeTask('wf-1/task-a', 'running', 'attempt-a', 'wf-1');
    const crossWorkflow = makeTask('wf-2/task-b', 'running', 'attempt-b', 'wf-2');
    const extraTopup = makeTask('wf-3/task-c', 'running', 'attempt-c', 'wf-3');
    const orchestrator = {
      startExecution: vi.fn().mockReturnValue([scoped, crossWorkflow, extraTopup]),
    };
    const taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: orchestrator as any,
      taskExecutor: taskExecutor as any,
      context: 'test.dispatch-dedupes-prestarted',
      started: [scoped, crossWorkflow],
      scopedWorkflowId: 'wf-1',
    });

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([crossWorkflow, extraTopup]);
  });

  it('returns scoped started tasks before running global top-up', async () => {
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

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([topupTask]);
  });

  it('fire-and-forget mode still returns the runnable set without in-process dispatch', async () => {
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

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(result.runnable).toEqual([scoped]);
    expect(result.topup).toEqual([]);
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

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(topup).toEqual([topupTask]);
  });

  it('finalizeMutationWithGlobalTopup returns started runnable work', async () => {
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

    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(result.started).toEqual([scoped]);
    expect(result.topup).toEqual([]);
  });
});
