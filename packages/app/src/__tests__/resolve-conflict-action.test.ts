/**
 * Ensures GUI `invoker:resolve-conflict` and `--headless resolve-conflict` share
 * `resolveConflictAction` with correct call order and failure handling.
 *
 * Repro / guard: before this action existed only in main.ts IPC; headless had no equivalent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';
import type { SQLiteAdapter } from '@invoker/data-store';
import { resolveConflictAction } from '../workflow-actions.js';

describe('resolveConflictAction', () => {
  let orchestrator: {
    getTask: ReturnType<typeof vi.fn>;
    beginConflictResolution: ReturnType<typeof vi.fn>;
    setFixAwaitingApproval: ReturnType<typeof vi.fn>;
    revertConflictResolution: ReturnType<typeof vi.fn>;
    approve?: ReturnType<typeof vi.fn>;
  };
  let persistence: { appendTaskOutput: ReturnType<typeof vi.fn> };
  let taskExecutor: {
    resolveConflict: ReturnType<typeof vi.fn>;
    executeTasks?: ReturnType<typeof vi.fn>;
    publishAfterFix?: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      getTask: vi.fn(() => ({
        id: 'task-a',
        status: 'fixing_with_ai',
        execution: { selectedAttemptId: 'att-1', generation: 1 },
      })),
      beginConflictResolution: vi.fn(() => ({ savedError: 'saved-err' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
    };
    persistence = { appendTaskOutput: vi.fn() };
    taskExecutor = {
      resolveConflict: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('runs beginConflictResolution → resolveConflict → setFixAwaitingApproval', async () => {
    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    const lineage = { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 1 };
    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a', lineage);
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', 'saved-err', undefined);
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-err', lineage);
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('auto-approves after conflict resolution when configured', async () => {
    const approve = vi.fn(async () => [{ id: 'task-a', status: 'completed', config: {}, execution: {} }]);
    const getTask = orchestrator.getTask;
    orchestrator = {
      ...orchestrator,
      getTask,
      approve,
    };
    const taskExecutorWithApprove = {
      ...taskExecutor,
      executeTasks: vi.fn(),
      publishAfterFix: vi.fn(),
    };

    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutorWithApprove as unknown as TaskRunner,
      autoApproveAIFixes: true,
    });

    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-err', {
      taskId: 'task-a',
      selectedAttemptId: 'att-1',
      generation: 1,
    });
    expect(approve).toHaveBeenCalledWith('task-a');
    expect(taskExecutorWithApprove.executeTasks).not.toHaveBeenCalled();
    expect(taskExecutorWithApprove.publishAfterFix).not.toHaveBeenCalled();
  });

  it('on failure appends output and reverts conflict resolution (does not set awaiting approval)', async () => {
    taskExecutor.resolveConflict.mockRejectedValue(new Error('claude failed'));

    await expect(
      resolveConflictAction('task-a', {
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      }),
    ).rejects.toThrow('claude failed');

    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Resolve Conflict] Failed:'),
    );
    expect(orchestrator.revertConflictResolution).toHaveBeenCalledWith(
      'task-a',
      'saved-err',
      'claude failed',
      { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 1 },
    );
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
  });
});
