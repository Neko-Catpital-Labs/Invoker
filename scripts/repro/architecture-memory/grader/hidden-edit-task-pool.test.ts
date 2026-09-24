import { describe, it, expect, vi } from 'vitest';
import { OrchestratorError } from '@invoker/workflow-core';
import type { Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { WorkflowMutationFacade, type WorkflowMutationFacadeDeps } from '../workflow-mutation-facade.js';

type Outcome =
  | { ok: true; data: unknown[] }
  | { ok: false; error: { code: string; message: string } };

function task(id: string, workflowId: string, status = 'running') {
  return {
    id,
    status,
    description: id,
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId },
    execution: {},
  };
}

function harness(outcome?: Outcome) {
  const started = [
    task('task-a', 'wf-1'),
    task('task-b', 'wf-1'),
    task('task-z', 'wf-2'),
    task('task-idle', 'wf-1', 'pending'),
  ];
  const orchestrator = {
    getTask: vi.fn((id: string) => (id === 'task-a' ? task('task-a', 'wf-1', 'failed') : undefined)),
    getAllTasks: vi.fn(() => []),
    startExecution: vi.fn(() => []),
    editTaskPool: vi.fn(() => started),
  };
  const taskExecutor = {
    executeTasks: vi.fn(async () => undefined),
    closeWorkflowReview: vi.fn(async () => undefined),
  };
  const commandService = {
    editTaskPool: vi.fn(async (envelope: { payload: { taskId: string; poolId: string } }) => {
      if (outcome) return outcome;
      return { ok: true as const, data: orchestrator.editTaskPool(envelope.payload.taskId, envelope.payload.poolId) };
    }),
  };
  const deps: WorkflowMutationFacadeDeps = {
    orchestrator: orchestrator as unknown as Orchestrator,
    persistence: {} as unknown as SQLiteAdapter,
    commandService: commandService as unknown as WorkflowMutationFacadeDeps['commandService'],
    taskExecutor: taskExecutor as unknown as TaskRunner,
  };
  const facade = new WorkflowMutationFacade(deps) as unknown as {
    editTaskPool?: (taskId: string, poolId: string) => Promise<{ started: any[]; runnable: any[]; topup: any[] }>;
  };
  return { facade, orchestrator, taskExecutor, commandService, started };
}

describe('archmem hidden: WorkflowMutationFacade.editTaskPool', () => {
  it('exposes editTaskPool(taskId, poolId) on the facade', () => {
    const { facade } = harness();
    expect(typeof facade.editTaskPool).toBe('function');
  });

  it('routes the mutation through CommandService.editTaskPool exactly once with the requested payload', async () => {
    const { facade, commandService, orchestrator } = harness();
    await facade.editTaskPool!('task-a', 'pool-gpu');
    expect(commandService.editTaskPool).toHaveBeenCalledTimes(1);
    const envelope = commandService.editTaskPool.mock.calls[0][0] as { scope?: string; payload: Record<string, unknown> };
    expect(envelope.payload).toMatchObject({ taskId: 'task-a', poolId: 'pool-gpu' });
    expect(envelope.scope).toBe('task');
    expect(orchestrator.editTaskPool).toHaveBeenCalledTimes(1);
  });

  it('closes the owning workflow review before the mutation runs', async () => {
    const { facade, commandService, taskExecutor } = harness();
    await facade.editTaskPool!('task-a', 'pool-gpu');
    expect(taskExecutor.closeWorkflowReview).toHaveBeenCalledWith('wf-1');
    expect(taskExecutor.closeWorkflowReview.mock.invocationCallOrder[0]).toBeLessThan(
      commandService.editTaskPool.mock.invocationCallOrder[0],
    );
  });

  it('dispatches only the edited task as mutation-scoped work and tops up the rest', async () => {
    const { facade, orchestrator, started } = harness();
    const result = await facade.editTaskPool!('task-a', 'pool-gpu');
    expect(result.started.map((t) => t.id)).toEqual(started.map((t) => t.id));
    expect(result.runnable.map((t) => t.id)).toEqual(['task-a']);
    expect(result.topup.map((t) => t.id).sort()).toEqual(['task-b', 'task-z']);
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
  });

  it('maps a known CommandService error code to OrchestratorError and dispatches nothing', async () => {
    const { facade, orchestrator } = harness({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'no such task' } });
    await expect(facade.editTaskPool!('task-a', 'pool-gpu')).rejects.toBeInstanceOf(OrchestratorError);
    expect(orchestrator.startExecution).not.toHaveBeenCalled();
  });

  it('surfaces an unknown CommandService failure message and dispatches nothing', async () => {
    const { facade, orchestrator } = harness({ ok: false, error: { code: 'EDIT_TASK_POOL_FAILED', message: 'pool missing' } });
    await expect(facade.editTaskPool!('task-a', 'pool-gpu')).rejects.toThrow('pool missing');
    expect(orchestrator.startExecution).not.toHaveBeenCalled();
  });
});
