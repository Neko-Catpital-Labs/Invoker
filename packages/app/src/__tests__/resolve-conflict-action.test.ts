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

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import { resolveConflictAction } from '../workflow-actions.js';

describe('resolveConflictAction', () => {
  let orchestrator: {
    getTask: ReturnType<typeof vi.fn>;
    beginFixSession: ReturnType<typeof vi.fn>;
    setFixAwaitingApproval: ReturnType<typeof vi.fn>;
    revertFixSession: ReturnType<typeof vi.fn>;
    approve?: ReturnType<typeof vi.fn>;
  };
  let persistence: { appendTaskOutput: ReturnType<typeof vi.fn> };
  let taskExecutor: {
    resolveConflict: ReturnType<typeof vi.fn>;
    executeTasks?: ReturnType<typeof vi.fn>;
    publishAfterFix?: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    loadConfigMock.mockReturnValue({});
    orchestrator = {
      getTask: vi.fn(() => ({
        id: 'task-a',
        status: 'fixing_with_ai',
        execution: { selectedAttemptId: 'att-1', generation: 1 },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'saved-err' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    persistence = { appendTaskOutput: vi.fn() };
    taskExecutor = {
      resolveConflict: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('runs beginFixSession → resolveConflict → setFixAwaitingApproval', async () => {
    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.beginFixSession).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', 'saved-err', 'codex', undefined);
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-err');
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('applies conflictResolutionAgent and conflictResolutionModel from config', async () => {
    loadConfigMock.mockReturnValue({
      conflictResolutionAgent: 'omp',
      conflictResolutionModel: 'gpt-5-mini',
    });

    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith(
      'task-a',
      'saved-err',
      'omp',
      'gpt-5-mini',
    );
  });

  it('lets an explicit agent override conflictResolutionAgent but still applies the config model', async () => {
    loadConfigMock.mockReturnValue({
      conflictResolutionAgent: 'omp',
      conflictResolutionModel: 'gpt-5-mini',
    });

    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    }, 'claude');

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith(
      'task-a',
      'saved-err',
      'claude',
      'gpt-5-mini',
    );
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
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', { savedError: 'saved-err', fixError: 'claude failed' });
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
  });
});
