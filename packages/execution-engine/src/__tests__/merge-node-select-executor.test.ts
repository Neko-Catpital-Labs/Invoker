import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';
import { selectExecutor, type TaskRunnerPoolHost } from '../task-runner-pool.js';
import type { MergeRunnerHost } from '../merge-runner.js';

function makeMergeTask(runnerKind: string = 'worktree'): TaskState {
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

function makeSelectExecutorHost(): TaskRunnerPoolHost & MergeRunnerHost {
  const worktree = { type: 'worktree' };
  const merge = { type: 'merge' };
  return {
    pendingPoolSelections: new Map(),
    activeExecutions: new Map(),
    poolRoundRobinCursor: new Map(),
    poolMemberHealth: new Map(),
    sshExecutorCache: new Map(),
    worktreeExecutorCache: new Map(),
    runnerInstanceId: 'test-runner',
    persistence: {} as unknown,
    getRemoteTargets: () => ({}),
    getWorktreeTargets: () => ({}),
    getExecutionPools: () => ({}),
    resolveExecutionAgent: () => 'test-agent',
    resolveExecutionModel: () => undefined,
    executorRegistry: {
      getDefault: () => worktree,
      get: (type: string) => {
        if (type === 'merge') return merge;
        if (type === 'worktree') return worktree;
        return null;
      },
      getAll: () => [worktree, merge],
      register: vi.fn(),
    },
    dockerConfig: {} as unknown,
    executionAgentRegistry: {} as unknown,
    maxWorktreesPerRepo: 1,
    orchestrator: { getTask: () => null, getAllTasks: () => [] },
  } as unknown as TaskRunnerPoolHost & MergeRunnerHost;
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

  it('selects the merge executor via a direct selectExecutor call even when runnerKind is a stale non-worktree value', () => {
    const host = makeSelectExecutorHost();

    const selected = selectExecutor(host, makeMergeTask('sandbox'));

    expect(selected.executor.type).toBe('merge');
  });
});
