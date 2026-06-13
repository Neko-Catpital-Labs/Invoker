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
  return {
    orchestrator: {
      retryTask: vi.fn(() => [makeRunningTask()]),
      recreateTask: vi.fn(() => [makeRunningTask()]),
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
    } as unknown as Orchestrator,
    persistence: {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1 })),
      updateWorkflow: vi.fn(),
      loadTasks: vi.fn(() => []),
    } as unknown as SQLiteAdapter,
    taskExecutor: {
      executeTasks: vi.fn(),
      killActiveExecution: vi.fn(),
      closeWorkflowReview: vi.fn(),
    } as unknown as TaskRunner,
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
    it('calls orchestrator.retryTask and dispatches runnable tasks', async () => {
      const result = await facade.retryTask('task-a');

      expect(deps.orchestrator.retryTask).toHaveBeenCalledWith('task-a');
      expect(result.started).toHaveLength(1);
      expect(result.started[0].status).toBe('running');
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
    });
  });

  describe('recreateTask', () => {
    it('calls orchestrator.recreateTask and dispatches runnable tasks', async () => {
      const result = await facade.recreateTask('task-a');

      expect(deps.orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
      expect(result.started).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
    });
  });

  describe('editTaskCommand', () => {
    it('calls orchestrator.editTaskCommand and dispatches runnable tasks', async () => {
      const result = await facade.editTaskCommand('task-a', 'new-cmd');

      expect(deps.orchestrator.editTaskCommand).toHaveBeenCalledWith('task-a', 'new-cmd');
      expect(result.started).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
    });
  });

  describe('editTaskPrompt', () => {
    it('calls orchestrator.editTaskPrompt and dispatches runnable tasks', async () => {
      const result = await facade.editTaskPrompt('task-a', 'new prompt');

      expect(deps.orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-a', 'new prompt');
      expect(result.started).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
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
    it('calls orchestrator.editTaskAgent and dispatches', async () => {
      const result = await facade.editTaskAgent('task-a', 'claude');

      expect(deps.orchestrator.editTaskAgent).toHaveBeenCalledWith('task-a', 'claude');
      expect(result.started).toHaveLength(1);
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
    it('forks and dispatches runnable tasks', async () => {
      const result = await facade.forkWorkflow('wf-1');

      expect(deps.orchestrator.forkWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.forkedWorkflowId).toBe('wf-fork');
      expect(result.sourceWorkflowId).toBe('wf-1');
      expect(result.runnable).toHaveLength(1);
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
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
    it('delegates generation bumping to orchestrator.recreateWorkflow', async () => {
      const result = await facade.recreateWorkflow('wf-1');

      expect(deps.persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
      expect(deps.persistence.updateWorkflow).not.toHaveBeenCalled();
      expect(deps.orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.started).toHaveLength(1);
    });
  });

  describe('retryWorkflow', () => {
    it('calls orchestrator.retryWorkflow and dispatches', async () => {
      const result = await facade.retryWorkflow('wf-1');

      expect(deps.orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.started).toHaveLength(1);
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
      expect(deps.taskExecutor.executeTasks).toHaveBeenCalled();
    });
  });
});
