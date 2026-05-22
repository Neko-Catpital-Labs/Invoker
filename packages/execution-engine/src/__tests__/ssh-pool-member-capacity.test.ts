import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { ResourceLimitError } from '../repo-pool.js';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: { selectedAttemptId: `${id}-attempt`, generation: 0 },
  } as TaskState;
}

function makeRunner(overrides: {
  members?: Array<{ id: string; type: 'ssh'; maxConcurrentTasks?: number }>;
  strategy?: 'roundRobin' | 'leastLoaded';
  orchestrator?: any;
  persistence?: any;
  sshExecutor?: any;
} = {}): TaskRunner {
  const sshExecutor = overrides.sshExecutor ?? {
    type: 'ssh',
    start: vi.fn(),
    onComplete: vi.fn(),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn(),
    destroyAll: vi.fn(),
  };
  const members = overrides.members ?? [{ id: 'remote-a', type: 'ssh' as const, maxConcurrentTasks: 1 }];
  return new TaskRunner({
    orchestrator: overrides.orchestrator ?? { getTask: () => null, getAllTasks: () => [], deferTask: vi.fn() },
    persistence: overrides.persistence ?? { logEvent: vi.fn() },
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => type === 'ssh' ? sshExecutor : null,
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'remote-a': { host: 'remote-a.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-a' },
      'remote-b': { host: 'remote-b.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-b' },
    }),
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: overrides.strategy ?? 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members,
      },
    }),
  });
}

describe('SSH pool member capacity', () => {
  it('treats leastLoaded maxConcurrentTasksPerMember as a hard cap', () => {
    const runner = makeRunner();
    runner.selectExecutor(makeTask('wf-1/task-a'));

    expect(() => runner.selectExecutor(makeTask('wf-2/task-b'))).toThrow(/no member capacity/);
    try {
      runner.selectExecutor(makeTask('wf-2/task-b'));
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(ResourceLimitError);
    }
  });

  it('round-robin skips full members and uses the next available member', () => {
    const runner = makeRunner({
      strategy: 'roundRobin',
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
    });

    runner.selectExecutor(makeTask('wf-1/task-a'));
    runner.selectExecutor(makeTask('wf-2/task-b'));

    const selections = [...(runner as any).pendingPoolSelections.values()];
    expect(selections.map((selection: any) => selection.member.id)).toEqual(['remote-a', 'remote-b']);
  });

  it('treats persisted poolMemberId on a pool-routed SSH task as consuming member capacity', () => {
    const runner = makeRunner({
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
    });
    const firstTask = makeTask('wf-1/task-a');
    firstTask.config = { ...firstTask.config, poolMemberId: 'remote-a' };
    const secondTask = makeTask('wf-2/task-b');
    secondTask.config = { ...secondTask.config, poolMemberId: 'remote-a' };

    runner.selectExecutor(firstTask);

    expect(() => runner.selectExecutor(secondTask)).toThrow(/no member capacity/);
    const selections = [...(runner as any).pendingPoolSelections.values()];
    expect(selections.map((selection: any) => selection.member.id)).toEqual(['remote-a']);
  });

  it('does not reselect an excluded persisted poolMemberId', () => {
    const runner = makeRunner({
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
    });
    const task = makeTask('wf-1/task-a');
    task.config = { ...task.config, poolMemberId: 'remote-a' };

    expect(() => runner.selectExecutor(task, new Set(['ssh:remote-a']))).toThrow(/no member capacity/);
    expect([...(runner as any).pendingPoolSelections.values()]).toHaveLength(0);
  });

  it('defers instead of starting when all pool members are full', async () => {
    const firstTask = makeTask('wf-1/task-a');
    const secondTask = makeTask('wf-2/task-b');
    const sshExecutor = {
      type: 'ssh',
      start: vi.fn(),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const deferTask = vi.fn();
    const runner = makeRunner({
      sshExecutor,
      orchestrator: {
        getTask: (id: string) => id === secondTask.id ? secondTask : firstTask,
        getAllTasks: () => [firstTask, secondTask],
        deferTask,
      },
      persistence: {
        logEvent: vi.fn(),
        updateAttempt: vi.fn(),
      },
    });

    runner.selectExecutor(firstTask);
    await runner.executeTask(secondTask);

    expect(deferTask).toHaveBeenCalledWith(secondTask.id);
    expect(sshExecutor.start).not.toHaveBeenCalled();
  });

  it('uses execution resource leases to defer across TaskRunner instances', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const firstTask = makeTask('wf-1/task-a');
      const secondTask = makeTask('wf-2/task-b');
      let firstComplete: ((response: any) => void) | undefined;
      const firstExecutor = {
        type: 'ssh',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/remote/task-a',
        })),
        onComplete: vi.fn((_handle: any, cb: any) => { firstComplete = cb; }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const secondExecutor = {
        type: 'ssh',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/remote/task-b',
        })),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const firstRunner = makeRunner({
        sshExecutor: firstExecutor,
        orchestrator: {
          getTask: () => firstTask,
          getAllTasks: () => [firstTask],
          markTaskRunningAfterLaunch: () => true,
          handleWorkerResponse: () => [],
          deferTask: vi.fn(),
        },
        persistence: {
          updateTask: vi.fn(),
          updateAttempt: vi.fn(),
          appendTaskOutput: vi.fn(),
          logEvent: vi.fn(),
          claimExecutionResourceLease: adapter.claimExecutionResourceLease.bind(adapter),
          renewExecutionResourceLease: adapter.renewExecutionResourceLease.bind(adapter),
          releaseExecutionResourceLease: adapter.releaseExecutionResourceLease.bind(adapter),
        },
      });
      const deferTask = vi.fn();
      const secondRunner = makeRunner({
        sshExecutor: secondExecutor,
        orchestrator: {
          getTask: () => secondTask,
          getAllTasks: () => [secondTask],
          markTaskRunningAfterLaunch: () => true,
          handleWorkerResponse: () => [],
          deferTask,
        },
        persistence: {
          ...adapter,
          updateTask: vi.fn(),
          updateAttempt: vi.fn(),
          appendTaskOutput: vi.fn(),
          logEvent: vi.fn(),
          claimExecutionResourceLease: adapter.claimExecutionResourceLease.bind(adapter),
          renewExecutionResourceLease: adapter.renewExecutionResourceLease.bind(adapter),
          releaseExecutionResourceLease: adapter.releaseExecutionResourceLease.bind(adapter),
        },
      });

      const firstRun = firstRunner.executeTask(firstTask);
      await vi.waitFor(() => expect(firstExecutor.start).toHaveBeenCalledTimes(1));
      await secondRunner.executeTask(secondTask);

      expect(secondExecutor.start).not.toHaveBeenCalled();
      expect(deferTask).toHaveBeenCalledWith(secondTask.id);

      firstComplete?.({
        requestId: 'req',
        actionId: firstTask.id,
        attemptId: firstTask.execution.selectedAttemptId,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
      await firstRun;
    } finally {
      adapter.close();
    }
  });
});
