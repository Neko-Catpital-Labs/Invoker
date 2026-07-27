import { describe, expect, it } from 'vitest';
import { ExecutorRegistry, TaskRunner } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(config: Partial<TaskState['config']>): TaskState {
  return {
    id: 'wf-1/verify-routing-command',
    description: 'Command task validates poolId routing',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config,
    execution: {},
  } as TaskState;
}

describe('executor routing for local proof pools', () => {
  it('uses the default local worktree executor when a worktree pool member has no target override', async () => {
    const runner = new TaskRunner({
      orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
      persistence: {} as any,
      executorRegistry: new ExecutorRegistry(),
      cwd: process.cwd(),
      worktreeTargetsProvider: () => ({}),
      executionPoolsProvider: () => ({
        'dummy-target': {
          members: [{ type: 'worktree', id: 'local-worktree' }],
        },
      }),
    });

    const selected = runner.selectExecutor(makeTask({ poolId: 'dummy-target' }));

    try {
      expect(selected.executor.type).toBe('worktree');
      expect(selected.selectedPoolMemberId).toBe('local-worktree');
    } finally {
      await selected.executor.destroyAll();
    }
  });
});
