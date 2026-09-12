import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { poolMemberHasCapacity, reclaimOrphanedExecutionSlots } from '../task-runner-pool.js';
import type { TaskState } from '@invoker/workflow-core';

const POOL = {
  selectionStrategy: 'leastLoaded' as const,
  maxConcurrentTasksPerMember: 2,
  members: [{ id: 'local-only', type: 'worktree' as const, maxConcurrentTasks: 2 }],
};

const MEMBER = POOL.members[0];

function makeRunner(tasks: TaskState[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const runner = new TaskRunner({
    orchestrator: {
      getTask: (id: string) => byId.get(id) ?? null,
      getAllTasks: () => tasks,
      deferTask: vi.fn(),
    } as never,
    persistence: { logEvent: vi.fn(), releaseExecutionResourceLease: vi.fn() } as never,
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
  return runner;
}

function makeTask(id: string, status: string): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'worktree', poolId: 'local-only' },
    execution: { generation: 0 },
  } as unknown as TaskState;
}

function pendingSelections(runner: TaskRunner): Map<string, unknown> {
  return (runner as unknown as { pendingPoolSelections: Map<string, unknown> }).pendingPoolSelections;
}

function reserve(runner: TaskRunner, taskId: string): void {
  pendingSelections(runner).set(taskId, {
    poolId: 'local-only',
    member: MEMBER,
    memberKey: 'worktree:local-only',
    selectionStrategy: 'leastLoaded',
  });
}

function hasCapacity(runner: TaskRunner): boolean {
  return poolMemberHasCapacity(runner as never, 'local-only', POOL as never, MEMBER as never);
}

describe('pending pool selections held by unlaunchable tasks', () => {
  it('counts a reservation against member capacity exactly like a live execution', () => {
    const runner = makeRunner([makeTask('wf-1/repair', 'failed'), makeTask('wf-2/repair', 'cancelled')]);
    reserve(runner, 'wf-1/repair');
    reserve(runner, 'wf-2/repair');

    expect(hasCapacity(runner)).toBe(false);
  });

  it('leaves a member wedged when every holder reached a terminal status', () => {
    const runner = makeRunner([makeTask('wf-1/repair', 'failed'), makeTask('wf-2/repair', 'cancelled')]);
    reserve(runner, 'wf-1/repair');
    reserve(runner, 'wf-2/repair');

    reclaimOrphanedExecutionSlots(runner as never);

    expect(hasCapacity(runner)).toBe(false);
    expect(pendingSelections(runner).size).toBe(2);
  });

  it('keeps a reservation whose task no longer exists', () => {
    const runner = makeRunner([makeTask('wf-live/repair', 'queued')]);
    reserve(runner, 'wf-deleted/repair');

    reclaimOrphanedExecutionSlots(runner as never);

    expect(pendingSelections(runner).has('wf-deleted/repair')).toBe(true);
  });

  it('never frees a reservation held by a task that can still launch', () => {
    const runner = makeRunner([makeTask('wf-3/repair', 'queued'), makeTask('wf-4/repair', 'running')]);
    reserve(runner, 'wf-3/repair');
    reserve(runner, 'wf-4/repair');

    reclaimOrphanedExecutionSlots(runner as never);

    expect(pendingSelections(runner).size).toBe(2);
    expect(hasCapacity(runner)).toBe(false);
  });

  it('does not wipe reservations when the orchestrator reports no tasks', () => {
    const runner = makeRunner([]);
    reserve(runner, 'wf-boot/repair');

    reclaimOrphanedExecutionSlots(runner as never);

    expect(pendingSelections(runner).has('wf-boot/repair')).toBe(true);
  });
});
