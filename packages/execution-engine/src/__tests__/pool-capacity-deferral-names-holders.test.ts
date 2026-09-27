import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

const POOL = {
  selectionStrategy: 'leastLoaded' as const,
  maxConcurrentTasksPerMember: 1,
  members: [{ id: 'local-only', type: 'worktree' as const, maxConcurrentTasks: 1 }],
};

function makeTask(id: string, status: string, selectedAttemptId?: string): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'worktree', poolId: 'local-only' },
    execution: { generation: 0, selectedAttemptId },
  } as unknown as TaskState;
}

describe('a launch deferred because a pool member is full', () => {
  it.fails('names the tasks holding the member in the deferral event', async () => {
    const holder = makeTask('wf-holder/repair', 'queued', 'wf-holder/repair-a1');
    const waiting = makeTask('wf-waiting/fix-ci', 'pending');
    const tasks = [holder, waiting];
    const logEvent = vi.fn();
    const runner = new TaskRunner({
      orchestrator: {
        getTask: (id: string) => tasks.find((task) => task.id === id) ?? null,
        getAllTasks: () => tasks,
        handleWorkerResponse: vi.fn(),
        deferTask: vi.fn(),
      } as never,
      persistence: { updateTask: vi.fn(), logEvent, releaseExecutionResourceLease: vi.fn() } as never,
      executorRegistry: { getDefault: () => null, get: () => null, getAll: () => [], register: vi.fn() } as never,
      cwd: '/tmp',
      remoteTargetsProvider: () => ({}),
      worktreeTargetsProvider: () => ({ 'local-only': { path: '/tmp/local-only' } }),
      executionPoolsProvider: () => ({ 'local-only': POOL }),
    } as never);
    (runner as unknown as { pendingPoolSelections: Map<string, unknown> }).pendingPoolSelections.set(holder.id, {
      poolId: 'local-only',
      member: POOL.members[0],
      memberKey: 'worktree:local-only',
      selectionStrategy: 'leastLoaded',
    });

    await runner.executeTask(waiting);

    const deferred = logEvent.mock.calls.find(([, type]) => type === 'task.executor.deferred');
    expect(deferred?.[0]).toBe(waiting.id);
    expect(deferred?.[2].members[0].holders).toEqual([
      { taskId: 'wf-holder/repair', kind: 'reservation' },
    ]);
  });
});
