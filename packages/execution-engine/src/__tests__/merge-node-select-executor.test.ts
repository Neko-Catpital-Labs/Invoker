import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';

function makeMergeTask(runnerKind: 'worktree' | 'merge' = 'worktree'): TaskState {
  return {
    id: '__merge__wf-x',
    description: 'Review gate',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: {
      isMergeNode: true,
      runnerKind,
      workflowId: 'wf-x',
    },
    execution: {
      selectedAttemptId: '__merge__wf-x-a1',
      generation: 1,
    },
  } as TaskState;
}

describe('selectExecutor merge-node routing', () => {
  it('selects MergeGateExecutor when isMergeNode is true even if runnerKind is worktree', () => {
    const worktree = {
      type: 'worktree',
      start: vi.fn(),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const merge = {
      type: 'merge',
      start: vi.fn(),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
      persistence: {} as any,
      executorRegistry: {
        getDefault: () => worktree,
        get: (type: string) => {
          if (type === 'merge') return merge;
          if (type === 'worktree') return worktree;
          return null;
        },
        getAll: () => [worktree, merge],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
    });

    const selected = runner.selectExecutor(makeMergeTask('worktree'));
    expect(selected.executor.type).toBe('merge');
  });
});
