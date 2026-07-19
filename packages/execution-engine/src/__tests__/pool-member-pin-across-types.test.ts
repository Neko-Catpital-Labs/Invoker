/**
 * Regression coverage for execution-pool member pinning across ALL member
 * types, not only SSH.
 *
 * `selectExecutor()` currently (a) drops the picked member's id whenever the
 * pick is not type `ssh`, so nothing is ever pinned back onto a task that
 * first ran on a `worktree` member, and (b) only matches an explicit
 * `poolMemberId` pin against `ssh` candidates, silently ignoring pins that
 * point at a `worktree` member. Together this lets a task that started on
 * the local worktree member get re-routed to an unrelated SSH host on a
 * later call to `selectExecutor()` (e.g. during `publishApprovedFix`),
 * which then tries to run git commands against a workspace path that only
 * exists on the original machine.
 *
 * These three cases are marked `it.fails` because the underlying defect is
 * still present; the follow-up fix flips them to `it` once
 * `selectExecutor()`'s pinning logic is made type-agnostic.
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(overrides: {
  id?: string;
  description?: string;
  status?: string;
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
} = {}): TaskState {
  return {
    id: overrides.id ?? 'test',
    description: overrides.description ?? 'Test task',
    status: overrides.status ?? 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { ...overrides.config },
    execution: { ...overrides.execution },
  } as TaskState;
}

function makeRunner() {
  return new TaskRunner({
    orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
    persistence: {} as any,
    executorRegistry: {
      getDefault: () => ({ type: 'worktree' }),
      get: () => null,
      getAll: () => [],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'member-remote': {
        host: 'remote.example.com',
        user: 'invoker',
        sshKeyPath: '/tmp/key-remote',
        managedWorkspaces: true,
      },
    }),
    executionPoolsProvider: () => ({
      'mixed-pool': {
        selectionStrategy: 'roundRobin', // deterministic rotation
        maxConcurrentTasksPerMember: 10,
        members: [
          { id: 'member-local', type: 'worktree' as const, maxConcurrentTasks: 10 },
          { id: 'member-remote', type: 'ssh' as const, maxConcurrentTasks: 10 },
        ],
      },
    }),
  });
}

describe('selectExecutor pool member pinning across types', () => {
  it.fails('returns a defined selectedPoolMemberId for a fresh worktree pick, not just SSH', () => {
    const runner = makeRunner();

    const task = makeTask({
      id: 'wf-1/task-1',
      config: { poolId: 'mixed-pool' },
    });

    const selected = runner.selectExecutor(task);

    expect(selected.executor.type).toBe('worktree'); // RR cursor=0 → member-local
    expect(selected.selectedPoolMemberId).toBe('member-local');
  });

  it.fails('honors a persisted worktree pin instead of rotating to the SSH member', () => {
    const runner = makeRunner();

    // Step 1: original run picks the worktree member (RR cursor=0 → member-local).
    const firstTask = makeTask({
      id: 'wf-1/task-1',
      config: { poolId: 'mixed-pool' },
    });
    const firstSelection = runner.selectExecutor(firstTask);
    expect(firstSelection.executor.type).toBe('worktree');
    expect(firstSelection.selectedPoolMemberId).toBe('member-local');

    // Advance the round-robin cursor the way another task's dispatch would,
    // so a fresh (unpinned) selection for the same pool would now land on
    // the SSH member instead.
    const otherTask = makeTask({
      id: 'wf-1/task-2',
      config: { poolId: 'mixed-pool' },
    });
    const otherSelection = runner.selectExecutor(otherTask);
    expect(otherSelection.executor.type).toBe('ssh'); // RR cursor=1 → member-remote

    // Step 2: simulate what production should persist after step 1 — the
    // selected member id pinned back onto the task's config — and call
    // selectExecutor again for the same task (e.g. via publishApprovedFix).
    const selectPoolMemberSpy = vi.spyOn(runner as any, 'selectPoolMember');
    const publishTask = makeTask({
      id: 'wf-1/task-1',
      config: { poolId: 'mixed-pool', poolMemberId: 'member-local' },
    });
    const publishSelection = runner.selectExecutor(publishTask);

    expect(selectPoolMemberSpy).not.toHaveBeenCalled();
    expect(publishSelection.executor.type).toBe('worktree');
    expect(publishSelection.selectedPoolMemberId).toBe('member-local');
  });

  it.fails('honors an explicit poolMemberId pinned to a non-SSH member without re-rolling selection', () => {
    const runner = makeRunner();

    const task = makeTask({
      id: 'wf-1/task-1',
      config: { poolId: 'mixed-pool', poolMemberId: 'member-local' },
    });

    const selectPoolMemberSpy = vi.spyOn(runner as any, 'selectPoolMember');

    const selected = runner.selectExecutor(task);

    expect(selectPoolMemberSpy).not.toHaveBeenCalled();
    expect(selected.executor.type).toBe('worktree');
    expect(selected.selectedPoolMemberId).toBe('member-local');
  });
});
