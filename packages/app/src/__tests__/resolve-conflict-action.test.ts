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

    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', 'saved-err', undefined);
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-err');
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('auto-approves after conflict resolution when configured', async () => {
    const approve = vi.fn(async () => [{ id: 'task-a', status: 'completed', config: {}, execution: {} }]);
    orchestrator = {
      ...orchestrator,
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

    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-err');
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
    );
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
  });
});
