import { describe, it, expect } from 'vitest';
import { TaskExecutor } from '../task-executor.js';
import type { TaskState } from '@invoker/core';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'test',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    ...overrides,
  } as TaskState;
}

function createExecutorWithTasks(tasks: Map<string, TaskState>): TaskExecutor {
  const orchestrator = {
    getTask: (id: string) => tasks.get(id),
  };

  return new TaskExecutor({
    orchestrator: orchestrator as any,
    persistence: {} as any,
    familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
    cwd: '/tmp',
  });
}

describe('TaskExecutor', () => {
  describe('collectUpstreamBranches', () => {
    it('collects branches from completed dependencies', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-1', makeTask({
        id: 'dep-1',
        status: 'completed',
        branch: 'experiment/dep-1',
      }));
      tasks.set('dep-2', makeTask({
        id: 'dep-2',
        status: 'completed',
        branch: 'experiment/dep-2',
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-1', 'dep-2'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual(['experiment/dep-1', 'experiment/dep-2']);
    });

    it('excludes dependencies without a branch field', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-with-branch', makeTask({
        id: 'dep-with-branch',
        status: 'completed',
        branch: 'experiment/dep-with-branch',
      }));
      tasks.set('dep-no-branch', makeTask({
        id: 'dep-no-branch',
        status: 'completed',
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-with-branch', 'dep-no-branch'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual(['experiment/dep-with-branch']);
    });

    it('excludes non-completed dependencies', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-running', makeTask({
        id: 'dep-running',
        status: 'running',
        branch: 'experiment/dep-running',
      }));
      tasks.set('dep-failed', makeTask({
        id: 'dep-failed',
        status: 'failed',
        branch: 'experiment/dep-failed',
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-running', 'dep-failed'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });

    it('returns empty array for tasks with no dependencies', () => {
      const executor = createExecutorWithTasks(new Map());
      const task = makeTask({ id: 'root', dependencies: [] });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });

    it('handles missing dependency tasks gracefully', () => {
      const executor = createExecutorWithTasks(new Map());
      const task = makeTask({
        id: 'child',
        dependencies: ['nonexistent'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });
  });
});
