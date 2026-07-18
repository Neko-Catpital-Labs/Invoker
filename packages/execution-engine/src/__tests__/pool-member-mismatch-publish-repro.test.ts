/**
 * Regression coverage for approved-fix publish on SSH pool tasks.
 *
 * A completed SSH task may have both poolId and poolMemberId persisted. During
 * approved-fix publish, executor selection must honor the persisted member
 * because each SSH host has an independent filesystem and the worktree exists
 * only on the original host.
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

describe('publishApprovedFix pool member mismatch', () => {
  it('honors stored poolMemberId instead of rotating to a different SSH host', () => {
    const remoteTargets = {
      'member-alpha': {
        host: 'alpha.example.com',
        user: 'invoker',
        sshKeyPath: '/tmp/key-alpha',
        managedWorkspaces: true,
      },
      'member-beta': {
        host: 'beta.example.com',
        user: 'invoker',
        sshKeyPath: '/tmp/key-beta',
        managedWorkspaces: true,
      },
    };

    // Spy on selectPoolMember to prove it IS called during publishApprovedFix's selectExecutor
    const selectPoolMemberSpy = vi.spyOn(
      TaskRunner.prototype as any,
      'selectPoolMember',
    );

    const runner = new TaskRunner({
      orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
      persistence: {} as any,
      executorRegistry: {
        getDefault: () => ({ type: 'worktree' }),
        get: () => null,
        getAll: () => [],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
      remoteTargetsProvider: () => remoteTargets,
      executionPoolsProvider: () => ({
        'ssh-pool': {
          selectionStrategy: 'roundRobin', // deterministic rotation
          maxConcurrentTasksPerMember: 10,
          members: [
            { id: 'member-alpha', type: 'ssh' as const, maxConcurrentTasks: 10 },
            { id: 'member-beta', type: 'ssh' as const, maxConcurrentTasks: 10 },
          ],
        },
      }),
    });

    // Step 1: Simulate original task execution — selects member-alpha via round-robin
    const execTask = makeTask({
      id: 'wf-1/task-1',
      config: {
        runnerKind: 'ssh',
        poolId: 'ssh-pool',
        // poolMemberId NOT yet set — first run populates it
      },
    });
    const execExecutor = runner.selectExecutor(execTask).executor;
    expect((execExecutor as any).host).toBe('alpha.example.com'); // RR cursor=0 → alpha

    // Step 2: Now simulate another task execution — round-rotates to beta
    const otherTask = makeTask({
      id: 'wf-1/task-2',
      config: {
        runnerKind: 'ssh',
        poolId: 'ssh-pool',
      },
    });
    const otherExecutor = runner.selectExecutor(otherTask).executor;
    expect((otherExecutor as any).host).toBe('beta.example.com'); // RR cursor=1 → beta

    // Advance the round-robin cursor so a fresh pool selection would choose beta.
    const dummyTask = makeTask({
      id: 'wf-1/task-3',
      config: { runnerKind: 'ssh', poolId: 'ssh-pool' },
    });
    runner.selectExecutor(dummyTask);

    // Now create the publish scenario — task has stored poolMemberId='member-alpha'
    const publishTask = makeTask({
      id: 'wf-1/task-1',
      description: 'Fix bug X',
      config: {
        runnerKind: 'ssh',
        poolId: 'ssh-pool',
        poolMemberId: 'member-alpha', // ← STORED from original execution
      },
      execution: {
        workspacePath: '/home/invoker/.invoker/worktrees/abc/experiment-wf-1-task-1-g1.t1.a-xxx',
        branch: 'experiment/wf-1-task-1-fix',
        selectedAttemptId: 'attempt-1',
        generation: 1,
      },
    });

    selectPoolMemberSpy.mockClear();

    // Call selectExecutor exactly as publishApprovedFix does.
    const publishExecutor = runner.selectExecutor(publishTask).executor;

    expect(selectPoolMemberSpy).not.toHaveBeenCalled();
    expect((publishExecutor as any).host).toBe('alpha.example.com');
  });

  it('does not invoke selectPoolMember when poolMemberId is explicitly set', () => {
    const runner = new TaskRunner({
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
        'member-alpha': {
          host: 'alpha.example.com',
          user: 'invoker',
          sshKeyPath: '/tmp/key',
          managedWorkspaces: true,
        },
      }),
      executionPoolsProvider: () => ({
        'ssh-pool': {
          selectionStrategy: 'leastLoaded',
          maxConcurrentTasksPerMember: 10,
          members: [
            { id: 'member-alpha', type: 'ssh' as const, maxConcurrentTasks: 10 },
          ],
        },
      }),
    });

    // Task with BOTH poolId AND explicit poolMemberId set
    const task = makeTask({
      id: 'wf-1/task-1',
      config: {
        runnerKind: 'ssh',
        poolId: 'ssh-pool',
        poolMemberId: 'member-alpha', // Explicitly pinned!
      },
    });

    const selectPoolMemberSpy = vi.spyOn(runner as any, 'selectPoolMember');

    runner.selectExecutor(task);

    expect(selectPoolMemberSpy).not.toHaveBeenCalled();
  });
});
