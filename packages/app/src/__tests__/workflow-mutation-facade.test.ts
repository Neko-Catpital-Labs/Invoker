/**
 * Unit tests for WorkflowMutationFacade.
 *
 * Verifies that the facade correctly wires shared actions to the
 * dispatch + topup lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { WorkflowMutationFacade, type WorkflowMutationFacadeDeps } from '../workflow-mutation-facade.js';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-a',
    status: 'pending' as const,
    description: 'test task',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: {},
    ...overrides,
  };
}

function makeRunningTask(overrides: Record<string, unknown> = {}) {
  return makeTask({ status: 'running', ...overrides });
}

function makeDeps(overrides: Partial<WorkflowMutationFacadeDeps> = {}): WorkflowMutationFacadeDeps {
  const orchestrator = {
    retryTask: vi.fn(() => [makeRunningTask()]),
    recreateTask: vi.fn(() => [makeRunningTask()]),
    recreateDownstream: vi.fn(() => [makeRunningTask({ id: 'task-b' })]),
    cancelTask: vi.fn(() => ({ cancelled: ['task-a'], runningCancelled: [] })),
    cancelWorkflow: vi.fn(() => ({ cancelled: ['task-a'], runningCancelled: ['task-a'] })),
    deleteWorkflow: vi.fn(),
    detachWorkflow: vi.fn(),
    forkWorkflow: vi.fn(() => ({
      forkedWorkflowId: 'wf-fork',
      sourceWorkflowId: 'wf-1',
      started: [makeRunningTask({ id: 'fork-t1' })],
    })),
    editTaskCommand: vi.fn(() => [makeRunningTask()]),
    editTaskPrompt: vi.fn(() => [makeRunningTask()]),
    editTaskType: vi.fn(() => [makeRunningTask()]),
    editTaskAgent: vi.fn(() => [makeRunningTask()]),
    setTaskExternalGatePolicies: vi.fn(() => []),
    selectExperiment: vi.fn(() => [makeRunningTask()]),
    approve: vi.fn(async () => [makeRunningTask()]),
    reject: vi.fn(),
    provideInput: vi.fn(),
    getTask: vi.fn(),
    getAllTasks: vi.fn(() => []),
    startExecution: vi.fn(() => []),
    retryWorkflow: vi.fn(() => [makeRunningTask()]),
    recreateWorkflow: vi.fn(() => [makeRunningTask()]),
    recreateWorkflowFromFreshBase: vi.fn(async () => [makeRunningTask()]),
    cascadeInvalidationToDownstream: vi.fn(() => []),
    cancelWorkflowExecution: vi.fn(),
  };
  const persistence = {
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1 })),
    updateWorkflow: vi.fn(),
    loadTasks: vi.fn(() => []),
  };
  const taskExecutor = {
    executeTasks: vi.fn(),
    killActiveExecution: vi.fn(),
    closeWorkflowReview: vi.fn(),
    preparePoolForRebaseRetry: vi.fn(async () => undefined),
  };
  const commandService = {
    retryTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.retryTask(envelope.payload.taskId) })),
    recreateTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.recreateTask(envelope.payload.taskId) })),
    recreateDownstream: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.recreateDownstream(envelope.payload.taskId) })),
    retryWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => ({ ok: true as const, data: orchestrator.retryWorkflow(envelope.payload.workflowId) })),
    recreateWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => {
      const workflow = persistence.loadWorkflow(envelope.payload.workflowId);
      persistence.updateWorkflow(envelope.payload.workflowId, { generation: (workflow.generation ?? 0) + 1 });
      return { ok: true as const, data: orchestrator.recreateWorkflow(envelope.payload.workflowId) };
    }),
    runSerializedForWorkflow: vi.fn(async (_workflowId: string | undefined, fn: () => Promise<TaskState[]> | TaskState[]) => ({ ok: true as const, data: await fn() })),
  };
  return {
    orchestrator: orchestrator as unknown as Orchestrator,
    persistence: persistence as unknown as SQLiteAdapter,
    commandService: commandService as unknown as WorkflowMutationFacadeDeps['commandService'],
    taskExecutor: taskExecutor as unknown as TaskRunner,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('WorkflowMutationFacade', () => {
  let deps: WorkflowMutationFacadeDeps;
  let facade: WorkflowMutationFacade;

  beforeEach(() => {
    deps = makeDeps();
    facade = new WorkflowMutationFacade(deps);
  });

  describe('retryTask', () => {
    it('calls orchestrator.retryTask and returns accepted runnable tasks', async () => {
      const result = await facade.retryTask('task-a');

      expect(deps.orchestrator.retryTask).toHaveBeenCalledWith('task-a');
      expect(result.started).toHaveLength(1);
      expect(result.started[0].status).toBe('running');
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('recreateTask', () => {
    it('calls orchestrator.recreateTask and returns accepted runnable tasks', async () => {
      const result = await facade.recreateTask('task-a');

      expect(deps.orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('editTaskCommand', () => {
    it('calls orchestrator.editTaskCommand and returns accepted runnable tasks', async () => {
      const result = await facade.editTaskCommand('task-a', 'new-cmd');

      expect(deps.orchestrator.editTaskCommand).toHaveBeenCalledWith('task-a', 'new-cmd');
      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('editTaskPrompt', () => {
    it('calls orchestrator.editTaskPrompt and returns accepted runnable tasks', async () => {
      const result = await facade.editTaskPrompt('task-a', 'new prompt');

      expect(deps.orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-a', 'new prompt');
      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('editTaskType', () => {
    it('calls orchestrator.editTaskType with optional poolMemberId', async () => {
      const result = await facade.editTaskType('task-a', 'docker', 'remote-1');

      expect(deps.orchestrator.editTaskType).toHaveBeenCalledWith('task-a', 'docker', 'remote-1');
      expect(result.started).toHaveLength(1);
    });
  });

  describe('editTaskAgent', () => {
    it('calls orchestrator.editTaskAgent and returns accepted runnable tasks', async () => {
      const result = await facade.editTaskAgent('task-a', 'claude');

      expect(deps.orchestrator.editTaskAgent).toHaveBeenCalledWith('task-a', 'claude');
      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('selectExperiment', () => {
    it('calls orchestrator.selectExperiment', async () => {
      const result = await facade.selectExperiment('task-a', 'exp-1');

      expect(deps.orchestrator.selectExperiment).toHaveBeenCalledWith('task-a', 'exp-1');
      expect(result.started).toHaveLength(1);
    });
  });

  describe('cancelTask', () => {
    it('calls orchestrator.cancelTask and kills running cancellations', async () => {
      const killFn = vi.fn();
      deps = makeDeps({
        killRunningTask: killFn,
        orchestrator: {
          ...deps.orchestrator,
          cancelTask: vi.fn(() => ({
            cancelled: ['task-a'],
            runningCancelled: ['task-a'],
          })),
          startExecution: vi.fn(() => []),
        } as unknown as Orchestrator,
      });
      facade = new WorkflowMutationFacade(deps);

      const result = await facade.cancelTask('task-a');

      expect(result.cancelled).toEqual(['task-a']);
      expect(result.runningCancelled).toEqual(['task-a']);
      expect(killFn).toHaveBeenCalledWith('task-a');
    });
  });

  describe('cancelWorkflow', () => {
    it('calls orchestrator.cancelWorkflow and kills running cancellations', async () => {
      const killFn = vi.fn();
      deps = makeDeps({
        killRunningTask: killFn,
        orchestrator: {
          ...deps.orchestrator,
          cancelWorkflow: vi.fn(() => ({
            cancelled: ['task-a'],
            runningCancelled: ['task-a'],
          })),
          startExecution: vi.fn(() => []),
        } as unknown as Orchestrator,
      });
      facade = new WorkflowMutationFacade(deps);

      const result = await facade.cancelWorkflow('wf-1');

      expect(result.cancelled).toEqual(['task-a']);
      expect(killFn).toHaveBeenCalledWith('task-a');
    });
  });

  describe('deleteWorkflow', () => {
    it('kills active tasks then calls orchestrator.deleteWorkflow', async () => {
      const killFn = vi.fn();
      deps = makeDeps({
        killRunningTask: killFn,
        orchestrator: {
          ...deps.orchestrator,
          getAllTasks: vi.fn(() => [
            makeRunningTask({ id: 'task-a', config: { workflowId: 'wf-1' } }),
            makeTask({ id: 'task-b', status: 'completed', config: { workflowId: 'wf-1' } }),
          ]),
        } as unknown as Orchestrator,
      });
      facade = new WorkflowMutationFacade(deps);

      await facade.deleteWorkflow('wf-1');

      expect(killFn).toHaveBeenCalledWith('task-a');
      expect(killFn).not.toHaveBeenCalledWith('task-b');
      expect(deps.taskExecutor.closeWorkflowReview).toHaveBeenCalledWith('wf-1');
      expect(deps.orchestrator.deleteWorkflow).toHaveBeenCalledWith('wf-1');
    });
  });

  describe('detachWorkflow', () => {
    it('calls orchestrator.detachWorkflow', async () => {
      await facade.detachWorkflow('wf-child', 'wf-parent');

      expect(deps.orchestrator.detachWorkflow).toHaveBeenCalledWith('wf-child', 'wf-parent');
    });
  });

  describe('forkWorkflow', () => {
    it('forks and returns accepted runnable tasks', async () => {
      const result = await facade.forkWorkflow('wf-1');

      expect(deps.orchestrator.forkWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.forkedWorkflowId).toBe('wf-fork');
      expect(result.sourceWorkflowId).toBe('wf-1');
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('rejectTask', () => {
    it('calls orchestrator.reject with reason', () => {
      facade.rejectTask('task-a', 'bad output');

      expect(deps.orchestrator.reject).toHaveBeenCalledWith('task-a', 'bad output');
    });

    it('reverts conflict resolution when task has pendingFixError', () => {
      const task = makeTask({
        execution: { pendingFixError: 'merge conflict' },
      });
      (deps.orchestrator.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
      (deps.orchestrator as any).revertConflictResolution = vi.fn();

      facade.rejectTask('task-a');

      expect((deps.orchestrator as any).revertConflictResolution).toHaveBeenCalledWith(
        'task-a',
        'merge conflict',
      );
    });
  });

  describe('provideInput', () => {
    it('calls orchestrator.provideInput', () => {
      facade.provideInput('task-a', 'user answer');

      expect(deps.orchestrator.provideInput).toHaveBeenCalledWith('task-a', 'user answer');
    });
  });

  describe('setTaskExternalGatePolicies', () => {
    it('calls orchestrator.setTaskExternalGatePolicies', async () => {
      const updates = [{ workflowId: 'wf-1', gatePolicy: 'completed' as const }];
      await facade.setTaskExternalGatePolicies('task-a', updates);

      expect(deps.orchestrator.setTaskExternalGatePolicies).toHaveBeenCalledWith('task-a', updates);
    });
  });

  describe('recreateWorkflow', () => {
    it('bumps generation and calls orchestrator.recreateWorkflow', async () => {
      const result = await facade.recreateWorkflow('wf-1');

      expect(deps.persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
      expect(deps.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 2 });
      expect(deps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.started).toHaveLength(1);
    });
  });

  describe('retryWorkflow', () => {
    it('calls orchestrator.retryWorkflow and returns accepted runnable tasks', async () => {
      const result = await facade.retryWorkflow('wf-1');

      expect(deps.orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });

    it('can return after launch acceptance without waiting for task runtime', async () => {
      deps = makeDeps({
        dispatchMode: 'fire-and-forget',
        taskExecutor: {
          executeTasks: vi.fn(() => new Promise<void>(() => {})),
          killActiveExecution: vi.fn(),
        } as unknown as TaskRunner,
      });
      facade = new WorkflowMutationFacade(deps);

      const result = await facade.retryWorkflow('wf-1');

      expect(result.started).toHaveLength(1);
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });

  describe('workflow scoped dispatch', () => {
    it('keeps cross-workflow starts in topup for retry-class workflow mutations', async () => {
      const scoped = makeRunningTask({
        id: 'wf-1/task-a',
        config: { workflowId: 'wf-1' },
        execution: { selectedAttemptId: 'attempt-a' },
      });
      const crossWorkflow = makeRunningTask({
        id: 'wf-2/task-b',
        config: { workflowId: 'wf-2' },
        execution: { selectedAttemptId: 'attempt-b' },
      });
      (deps.orchestrator.retryWorkflow as ReturnType<typeof vi.fn>).mockReturnValue([scoped, crossWorkflow]);

      const result = await facade.retryWorkflow('wf-1');

      expect(result.runnable).toEqual([scoped]);
      expect(result.topup).toEqual([crossWorkflow]);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });

    it('keeps cross-workflow starts in topup for rebase-recreate', async () => {
      const scoped = makeRunningTask({
        id: 'wf-1/task-a',
        config: { workflowId: 'wf-1' },
        execution: { selectedAttemptId: 'attempt-a' },
      });
      const crossWorkflow = makeRunningTask({
        id: 'wf-2/task-b',
        config: { workflowId: 'wf-2' },
        execution: { selectedAttemptId: 'attempt-b' },
      });
      (deps.orchestrator.recreateWorkflow as ReturnType<typeof vi.fn>).mockReturnValue([scoped, crossWorkflow]);

      const result = await facade.rebaseRecreate('wf-1');

      expect(result.runnable).toEqual([scoped]);
      expect(result.topup).toEqual([crossWorkflow]);
      expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    });
  });
});
