import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Repro + fix for the execution-pool capacity wedge behind stuck-pending tasks.
 *
 * Pool capacity (`task-runner-pool.ts` `poolMemberLoad`) counts a member as
 * loaded for every `activeExecutions` entry on it. That map is only cleared by
 * `onComplete` or `killActiveExecution`; when a running attempt is superseded
 * (recreate/invalidate) and neither fires — an orphaned remote executor, or a
 * kill hook that no-oped — its entry lingers and occupies the member forever.
 * Over a long-lived process this wedges every member at capacity while nothing
 * runs, so all launches fail with "no member capacity".
 *
 * `selectExecutor` now reclaims a task's own superseded slot before selecting,
 * and also reclaims other tasks' orphaned non-live attempts so cross-task
 * wedges cannot starve the pool.
 */
function makeRunner(orchestratorOverrides: Record<string, unknown> = {}) {
  const kill = vi.fn().mockResolvedValue(undefined);
  const sshExecutor = {
    type: 'ssh',
    start: vi.fn(),
    onComplete: vi.fn(),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill,
    destroyAll: vi.fn(),
  };
  const runner = new TaskRunner({
    orchestrator: {
      getTask: () => null,
      getAllTasks: () => [],
      deferTask: vi.fn(),
      ...orchestratorOverrides,
    } as never,
    persistence: { logEvent: vi.fn(), releaseExecutionResourceLease: vi.fn() } as never,
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => (type === 'ssh' ? sshExecutor : null),
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as never,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({ 'remote-a': { host: 'a', user: 'invoker', sshKeyPath: '/tmp/k' } }),
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 }],
      },
    }),
  } as never);
  return { runner, sshExecutor, kill };
}

function makeTask(id: string, attempt: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: { selectedAttemptId: attempt, generation: 0 },
  } as TaskState;
}

function strandActiveExecution(runner: TaskRunner, sshExecutor: unknown, taskId: string, attemptId: string): void {
  (runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.set(attemptId, {
    handle: { attemptId },
    executor: sshExecutor,
    taskId,
    poolId: 'ssh-pool',
    poolMemberKey: 'ssh:remote-a',
  });
}

describe('pool capacity: superseded execution slot leak', () => {
  it("reclaims a task's stranded prior-attempt slot so its next launch is not wedged", () => {
    const { runner, sshExecutor, kill } = makeRunner();
    // A prior attempt of task-a launched on remote-a and was never reaped.
    strandActiveExecution(runner, sshExecutor, 'wf-1/task-a', 'wf-1/task-a-old');

    // remote-a (capacity 1) reads full from the stale entry, but task-a's next
    // attempt must still launch on its own member.
    const task = makeTask('wf-1/task-a', 'wf-1/task-a-new');
    expect(() => runner.selectExecutor(task)).not.toThrow();

    expect((runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.has('wf-1/task-a-old')).toBe(false);
    expect(runner.pendingPoolSelections.get('wf-1/task-a')?.member.id).toBe('remote-a');
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("does not reclaim another task's live execution slot (no over-subscription)", () => {
    const liveTask = makeTask('wf-1/task-a', 'wf-1/task-a-live');
    liveTask.status = 'running';
    const { runner, sshExecutor, kill } = makeRunner({
      getTask: (id: string) => (id === liveTask.id ? liveTask : null),
      getAllTasks: () => [liveTask],
    });
    // task-a is genuinely running on remote-a.
    strandActiveExecution(runner, sshExecutor, 'wf-1/task-a', 'wf-1/task-a-live');

    // A different task selecting the pool must still see remote-a as full.
    expect(() => runner.selectExecutor(makeTask('wf-2/task-b', 'wf-2/task-b-attempt'))).toThrow(/no member capacity/);
    expect((runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.has('wf-1/task-a-live')).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("reclaims another task's orphaned non-live attempt so a waiter can fill the member", () => {
    // task-a was recreated: live selected attempt is new, but the old attempt
    // still occupies activeExecutions (kill/onComplete never ran).
    const taskA = makeTask('wf-1/task-a', 'wf-1/task-a-new');
    const { runner, sshExecutor, kill } = makeRunner({
      getTask: (id: string) => (id === taskA.id ? taskA : null),
      getAllTasks: () => [taskA],
    });
    strandActiveExecution(runner, sshExecutor, 'wf-1/task-a', 'wf-1/task-a-old');

    expect(() => runner.selectExecutor(makeTask('wf-2/task-b', 'wf-2/task-b-attempt'))).not.toThrow();
    expect((runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.has('wf-1/task-a-old')).toBe(false);
    expect(runner.pendingPoolSelections.get('wf-2/task-b')?.member.id).toBe('remote-a');
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
