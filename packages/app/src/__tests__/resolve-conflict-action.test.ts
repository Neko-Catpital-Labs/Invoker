/**
 * Ensures GUI `invoker:resolve-conflict` and `--headless resolve-conflict` share
 * `resolveConflictWithClaudeAction` (same call order and failure handling).
 *
 * Repro / guard: before this action existed only in main.ts IPC; headless had no equivalent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator } from '@invoker/core';
import type { TaskExecutor } from '@invoker/executors';
import type { SQLiteAdapter } from '@invoker/persistence';
import { resolveConflictWithClaudeAction } from '../workflow-actions.js';

describe('resolveConflictWithClaudeAction', () => {
  let orchestrator: {
    beginConflictResolution: ReturnType<typeof vi.fn>;
    restartTask: ReturnType<typeof vi.fn>;
    revertConflictResolution: ReturnType<typeof vi.fn>;
  };
  let persistence: { appendTaskOutput: ReturnType<typeof vi.fn> };
  let taskExecutor: {
    resolveConflictWithClaude: ReturnType<typeof vi.fn>;
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
      resolveConflictWithClaude: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('runs beginConflictResolution → resolveConflictWithClaude → restartTask → executeTasks', async () => {
    await resolveConflictWithClaudeAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskExecutor,
    });

    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflictWithClaude).toHaveBeenCalledWith('task-a');
    expect(orchestrator.restartTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'task-a', status: 'running' })]),
    );
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('on failure appends output and reverts conflict resolution (does not restart)', async () => {
    taskExecutor.resolveConflictWithClaude.mockRejectedValue(new Error('claude failed'));

    await expect(
      resolveConflictWithClaudeAction('task-a', {
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
