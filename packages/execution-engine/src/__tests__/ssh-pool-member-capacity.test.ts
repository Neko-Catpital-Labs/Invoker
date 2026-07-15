import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { SshExecutor } from '../ssh-executor.js';
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


  it('releases in-memory SSH pool capacity when a preempted task is killed through TaskRunner', async () => {
    const firstTask = makeTask('wf-1/task-a');
    const secondTask = makeTask('wf-2/task-b');
    const thirdTask = makeTask('wf-3/task-c');
    const tasks = new Map([firstTask, secondTask, thirdTask].map((task) => [task.id, task]));
    const handlesByTaskId = new Map<string, any>();
    const completeByTaskId = new Map<string, (response: any) => void>();
    const sshExecutor = {
      type: 'ssh',
      start: vi.fn(async (request: any) => {
        const handle = {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: `/remote/${request.actionId}`,
        };
        handlesByTaskId.set(request.actionId, handle);
        return handle;
      }),
      onComplete: vi.fn((handle: any, cb: any) => {
        completeByTaskId.set(handle.taskId, cb);
      }),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(async () => undefined),
      destroyAll: vi.fn(),
    };
    const deferTask = vi.fn();
    const runner = makeRunner({
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
      sshExecutor,
      orchestrator: {
        getTask: (id: string) => tasks.get(id) ?? null,
        getAllTasks: () => [...tasks.values()],
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: () => [],
        deferTask,
      },
      persistence: {
        logEvent: vi.fn(),
        updateTask: vi.fn(),
        updateAttempt: vi.fn(),
        appendTaskOutput: vi.fn(),
      },
    });

    const firstRun = runner.executeTask(firstTask);
    const secondRun = runner.executeTask(secondTask);
    await vi.waitFor(() => expect(sshExecutor.start).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(completeByTaskId.has(firstTask.id)).toBe(true));
    await vi.waitFor(() => expect(completeByTaskId.has(secondTask.id)).toBe(true));

    const firstAttemptId = firstTask.execution.selectedAttemptId;
    const secondAttemptId = secondTask.execution.selectedAttemptId;
    await sshExecutor.kill(handlesByTaskId.get(firstTask.id));
    await sshExecutor.kill(handlesByTaskId.get(secondTask.id));
    firstTask.execution = { ...firstTask.execution, selectedAttemptId: `${firstTask.id}-retry-attempt` };
    secondTask.execution = { ...secondTask.execution, selectedAttemptId: `${secondTask.id}-retry-attempt` };
    await runner.executeTask(thirdTask);
    expect(deferTask).toHaveBeenCalledWith(thirdTask.id);
    expect(sshExecutor.start).toHaveBeenCalledTimes(2);

    expect(await runner.killActiveExecution(firstTask.id)).toBe(true);
    expect(await runner.killActiveExecution(secondTask.id)).toBe(true);
    completeByTaskId.get(firstTask.id)?.({
      requestId: `kill-${firstTask.id}`,
      actionId: firstTask.id,
      attemptId: firstAttemptId,
      status: 'failed',
      outputs: { exitCode: 130 },
    });
    completeByTaskId.get(secondTask.id)?.({
      requestId: `kill-${secondTask.id}`,
      actionId: secondTask.id,
      attemptId: secondAttemptId,
      status: 'failed',
      outputs: { exitCode: 130 },
    });
    await firstRun;
    await secondRun;

    const thirdRun = runner.executeTask(thirdTask);
    await vi.waitFor(() => expect(sshExecutor.start).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(completeByTaskId.has(thirdTask.id)).toBe(true));
    completeByTaskId.get(thirdTask.id)?.({
      requestId: `complete-${thirdTask.id}`,
      actionId: thirdTask.id,
      attemptId: thirdTask.execution.selectedAttemptId,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await thirdRun;
  });

  it('logs when killActiveExecution cannot kill the executor handle', async () => {
    const task = makeTask('wf-1/task-a');
    const killErr = new Error('ssh gone');
    const sshExecutor = {
      type: 'ssh',
      start: vi.fn(),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(async () => {
        throw killErr;
      }),
      destroyAll: vi.fn(),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const runner = makeRunner({
      sshExecutor,
      orchestrator: {
        getTask: (id: string) => id === task.id ? task : null,
        getAllTasks: () => [task],
      },
      persistence: {
        logEvent: vi.fn(),
      },
    });

    (runner as any).logger = logger;
    (runner as any).activeExecutions.set(task.execution.selectedAttemptId, {
      handle: {
        executionId: 'exec-1',
        taskId: task.id,
      },
      executor: sshExecutor,
      taskId: task.id,
    });

    await expect(runner.killActiveExecution(task.id)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      `[TaskRunner] killActiveExecution failed for task=${task.id}`,
      { err: killErr },
    );
  });
  it('does not resolve crabbox for a static pool member (resolver untouched)', () => {
    const resolve = vi.fn();
    // A registry with no pre-registered ssh executor so the lazy SSH path runs.
    const staticRunner = new TaskRunner({
      orchestrator: { getTask: () => null, getAllTasks: () => [], deferTask: vi.fn() } as any,
      persistence: { logEvent: vi.fn() } as any,
      executorRegistry: {
        getDefault: () => ({ type: 'worktree' }),
        get: () => null,
        getAll: () => [],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
      remoteTargetsProvider: () => ({
        'remote-a': { host: 'remote-a.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-a' },
      }),
      executionPoolsProvider: () => ({
        'ssh-pool': { selectionStrategy: 'leastLoaded', maxConcurrentTasksPerMember: 1, members: [{ id: 'remote-a', type: 'ssh' as const, maxConcurrentTasks: 1 }] },
      }),
      crabboxResolver: { resolve },
    });

    const executor = staticRunner.selectExecutor(makeTask('wf-1/task-a'));
    expect(executor.type).toBe('ssh');
    expect((executor as any).host).toBe('remote-a.example.com');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keys the execution resource lease on the resolved crabbox endpoint while keeping the pool member id', async () => {
    vi.spyOn(SshExecutor.prototype, 'start').mockImplementation(async function (this: any, request: any) {
      return {
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: `/remote/${request.actionId}`,
        branch: `branch-${request.actionId}`,
      };
    });
    const completeByTask = new Map<string, (response: any) => void>();
    vi.spyOn(SshExecutor.prototype, 'onComplete').mockImplementation((handle: any, cb: any) => {
      completeByTask.set(handle.taskId, cb);
    });
    vi.spyOn(SshExecutor.prototype, 'onOutput').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'onHeartbeat').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'kill').mockImplementation(async () => {});

    try {
      const resolve = vi.fn(async (config: any) => ({
        sshTarget: { host: 'leased.crab', user: 'crab', sshKeyPath: '/leased/key', port: 2200 },
        remoteLeaseMetadata: {
          provider: 'crabbox' as const,
          leaseId: 'L1',
          slug: 'lease-slug',
          targetId: config.id,
          sshHost: 'leased.crab',
          sshUser: 'crab',
          sshPort: 2200,
          sshKeyPath: '/leased/key',
          expiresAt: '',
          stopAfter: config.stopAfter,
          keepOnFailure: config.keepOnFailure,
        },
      }));
      const claimCalls: any[] = [];
      const task = makeTask('wf/crab');
      const runner = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => (id === task.id ? task : null),
          getAllTasks: () => [task],
          markTaskRunningAfterLaunch: () => true,
          handleWorkerResponse: () => [],
          deferTask: vi.fn(),
        } as any,
        persistence: {
          updateTask: vi.fn(),
          updateAttempt: vi.fn(),
          appendTaskOutput: vi.fn(),
          logEvent: vi.fn(),
          loadAttempts: () => [],
          claimExecutionResourceLease: (args: any) => { claimCalls.push(args); return true; },
          renewExecutionResourceLease: vi.fn(),
          releaseExecutionResourceLease: vi.fn(),
        } as any,
        executorRegistry: {
          getDefault: () => ({ type: 'worktree' }),
          get: () => null,
          getAll: () => [],
          register: vi.fn(),
        } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({
          'crab-a': {
            type: 'crabbox' as const,
            crabboxCommand: 'crabbox',
            provider: 'do',
            class: 'medium',
            ttl: '30m',
            idleTimeout: '10m',
            network: 'default',
            target: 'ubuntu-22',
            stopAfter: 'completed',
            keepOnFailure: false,
          },
        }),
        executionPoolsProvider: () => ({
          'ssh-pool': {
            selectionStrategy: 'leastLoaded',
            maxConcurrentTasksPerMember: 1,
            members: [{ id: 'crab-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
          },
        }),
        crabboxResolver: { resolve },
      });

      const run = runner.executeTask(task);
      await vi.waitFor(() => expect(SshExecutor.prototype.start).toHaveBeenCalledTimes(1));

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(claimCalls).toHaveLength(1);
      // Resource key uses the RESOLVED endpoint; the pool member id is preserved.
      expect(claimCalls[0].resourceKey).toBe('ssh:crab@leased.crab:2200');
      expect(claimCalls[0].poolMemberId).toBe('crab-a');

      completeByTask.get(task.id)?.({
        requestId: 'r',
        actionId: task.id,
        attemptId: task.execution.selectedAttemptId,
        executionGeneration: task.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
      await run;
    } finally {
      vi.restoreAllMocks();
    }
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
