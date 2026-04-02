/**
 * Ensures GUI `invoker:resolve-conflict` and `--headless resolve-conflict` share
 * `resolveConflictAction` with correct call order and failure handling.
 *
 * Repro / guard: before this action existed only in main.ts IPC; headless had no equivalent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator } from '@invoker/core';
import type { TaskExecutor } from '@invoker/executors';
import type { SQLiteAdapter } from '@invoker/persistence';
import { resolveConflictAction } from '../workflow-actions.js';

describe('resolveConflictAction', () => {
  let orchestrator: {
    beginConflictResolution: ReturnType<typeof vi.fn>;
    restartTask: ReturnType<typeof vi.fn>;
    revertConflictResolution: ReturnType<typeof vi.fn>;
  };
  let persistence: { appendTaskOutput: ReturnType<typeof vi.fn> };
  let taskExecutor: {
    resolveConflict: ReturnType<typeof vi.fn>;
    executeTasks: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      beginConflictResolution: vi.fn(() => ({ savedError: 'saved-err' })),
      restartTask: vi.fn(() => [
        {
          id: 'task-a',
          status: 'running' as const,
          description: 'x',
          dependencies: [],
          createdAt: new Date(),
          config: {},
          execution: {},
        },
      ]),
      revertConflictResolution: vi.fn(),
    };
    persistence = { appendTaskOutput: vi.fn() };
    taskExecutor = {
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('runs beginConflictResolution → resolveConflict → restartTask → executeTasks', async () => {
    await resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskExecutor,
    });

    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', 'saved-err', undefined);
    expect(orchestrator.restartTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'task-a', status: 'running' })]),
    );
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('on failure appends output and reverts conflict resolution (does not restart)', async () => {
    taskExecutor.resolveConflict.mockRejectedValue(new Error('claude failed'));

    await expect(
      resolveConflictAction('task-a', {
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
        taskExecutor: taskExecutor as unknown as TaskExecutor,
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
    expect(orchestrator.restartTask).not.toHaveBeenCalled();
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });
});
