import { afterEach, describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { poolMemberHasCapacity } from '../task-runner-pool.js';
import { WorktreeExecutor } from '../worktree-executor.js';
import type { TaskState } from '@invoker/workflow-core';

const POOL = {
  selectionStrategy: 'leastLoaded' as const,
  maxConcurrentTasksPerMember: 1,
  members: [{ id: 'local-only', type: 'worktree' as const, maxConcurrentTasks: 1 }],
};

const MEMBER = POOL.members[0];

function makeTask(): TaskState {
  return {
    id: 'wf-1/fix-ci',
    description: 'wf-1/fix-ci',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'worktree', poolId: 'local-only' },
    execution: { generation: 0 },
  } as unknown as TaskState;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a launch whose executor returns no workspace path', () => {
  it.fails('leaves no pool reservation behind', async () => {
    const task = makeTask();
    const start = vi.spyOn(WorktreeExecutor.prototype, 'start').mockResolvedValue({
      executionId: 'exec-1',
      taskId: task.id,
      branch: 'experiment/wf-1-fix-ci',
    } as never);
    vi.spyOn(WorktreeExecutor.prototype, 'kill').mockResolvedValue(undefined as never);
    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [task],
        handleWorkerResponse: vi.fn(),
        deferTask: vi.fn(),
      } as never,
      persistence: { updateTask: vi.fn(), logEvent: vi.fn(), releaseExecutionResourceLease: vi.fn() } as never,
      executorRegistry: {
        getDefault: () => null,
        get: () => null,
        getAll: () => [],
        register: vi.fn(),
      } as never,
      cwd: '/tmp',
      remoteTargetsProvider: () => ({}),
      worktreeTargetsProvider: () => ({ 'local-only': { path: '/tmp/local-only' } }),
      executionPoolsProvider: () => ({ 'local-only': POOL }),
    } as never);

    await runner.executeTask(task);

    expect(start).toHaveBeenCalledTimes(1);
    const pending = (runner as unknown as { pendingPoolSelections: Map<string, unknown> }).pendingPoolSelections;
    expect(pending.has(task.id)).toBe(false);
    expect(poolMemberHasCapacity(runner as never, 'local-only', POOL as never, MEMBER as never)).toBe(true);
  });
});
