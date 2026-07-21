import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { ExecutionPoolMember } from '../task-runner-pool.js';
import { ResourceLimitError } from '../repo-pool.js';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  computePoolMemberCooldownMs,
  POOL_MEMBER_COOLDOWN_BASE_MS,
  POOL_MEMBER_COOLDOWN_MAX_MS,
} from '../task-runner-launch-support.js';

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

type RemoteTargetTestConfig = {
  host: string;
  user: string;
  sshKeyPath: string;
};

function makeRunner(overrides: {
  members?: ExecutionPoolMember[];
  strategy?: 'roundRobin' | 'leastLoaded';
  orchestrator?: unknown;
  persistence?: unknown;
  sshExecutor?: unknown;
  remoteTargets?: Record<string, RemoteTargetTestConfig>;
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
  const members = overrides.members ?? [{ id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 }];
  const remoteTargets = overrides.remoteTargets ?? {
    'remote-a': { host: 'remote-a.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-a' },
    'remote-b': { host: 'remote-b.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-b' },
  };
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
    remoteTargetsProvider: () => remoteTargets,
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: overrides.strategy ?? 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members,
      },
    }),
  });
}

function getPendingSelection(runner: TaskRunner, taskId: string) {
  const selection = runner.pendingPoolSelections.get(taskId);
  if (!selection) throw new Error(`Missing pending selection for ${taskId}`);
  return selection;
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

  it('routes any requested harness to a pool member without capability gating', () => {
    const task = makeTask('wf-1/task-codex');
    task.config = {
      ...task.config,
      executionAgent: 'codex',
      executionModel: 'gpt-5-codex',
    };
    const runner = makeRunner({
      members: [{ id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 }],
    });

    runner.selectExecutor(task);
    expect(getPendingSelection(runner, task.id).resolvedExecution).toEqual({
      executionAgent: 'codex',
      executionModel: 'gpt-5-codex',
    });
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

    expect(deferTask).toHaveBeenCalledWith(secondTask.id, expect.objectContaining({
      reason: 'resource-limit',
      attemptId: secondTask.execution.selectedAttemptId,
    }));
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
    // Both executions were killed but the mock never reaped their in-memory
    // slots, and each task's live attempt has since advanced. Dispatching a new
    // task must reclaim those superseded slots (their attempt is no longer live)
    // rather than read both members as full — releasing the wedged pool capacity
    // so the third task starts instead of deferring.
    const thirdRun = runner.executeTask(thirdTask);
    await vi.waitFor(() => expect(sshExecutor.start).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(completeByTaskId.has(thirdTask.id)).toBe(true));
    expect(deferTask).not.toHaveBeenCalled();

    completeByTaskId.get(thirdTask.id)?.({
      requestId: `complete-${thirdTask.id}`,
      actionId: thirdTask.id,
      attemptId: thirdTask.execution.selectedAttemptId,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await thirdRun;

    // A late completion for each reclaimed (superseded) attempt must settle its
    // original run as a safe no-op without re-wedging member capacity.
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
      expect(deferTask).toHaveBeenCalledWith(secondTask.id, expect.objectContaining({
        reason: 'resource-limit',
        attemptId: secondTask.execution.selectedAttemptId,
      }));

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

describe('computePoolMemberCooldownMs', () => {
  it('starts at the base cooldown and grows, capped at the max', () => {
    expect(computePoolMemberCooldownMs(1)).toBe(POOL_MEMBER_COOLDOWN_BASE_MS);
    expect(computePoolMemberCooldownMs(2)).toBe(Math.min(POOL_MEMBER_COOLDOWN_BASE_MS * 2, POOL_MEMBER_COOLDOWN_MAX_MS));
    expect(computePoolMemberCooldownMs(2)).toBeGreaterThanOrEqual(computePoolMemberCooldownMs(1));
    expect(computePoolMemberCooldownMs(1000)).toBe(POOL_MEMBER_COOLDOWN_MAX_MS);
  });

  it('clamps non-positive failure counts to the base cooldown', () => {
    expect(computePoolMemberCooldownMs(0)).toBe(POOL_MEMBER_COOLDOWN_BASE_MS);
    expect(computePoolMemberCooldownMs(-5)).toBe(POOL_MEMBER_COOLDOWN_BASE_MS);
  });
});

describe('execution-pool member circuit breaker', () => {
  afterEach(() => vi.useRealTimers());

  it('takes a member out of rotation after a transport failure and routes to a healthy member', () => {
    const runner = makeRunner({
      strategy: 'roundRobin',
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
    });

    // remote-a would be picked first by the round-robin cursor; evict it.
    runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('connection timed out'));

    runner.selectExecutor(makeTask('wf-1/task-a'));
    expect(getPendingSelection(runner, 'wf-1/task-a').member.id).toBe('remote-b');
  });

  it('re-admits a member automatically once its cooldown expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'));
    const runner = makeRunner();

    const health = runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('no route to host'));
    expect(runner.getPoolMemberHealthSnapshot().map((h) => h.memberKey)).toContain('ssh:remote-a');

    // Still down one ms before the cooldown ends.
    vi.setSystemTime(new Date(health.downUntil - 1));
    expect(runner.getPoolMemberHealthSnapshot().map((h) => h.memberKey)).toContain('ssh:remote-a');

    // Cooldown elapsed → back in rotation, no operator action needed.
    vi.setSystemTime(new Date(health.downUntil + 1));
    expect(runner.getPoolMemberHealthSnapshot()).toHaveLength(0);
    runner.selectExecutor(makeTask('wf-1/task-a'));
    expect(getPendingSelection(runner, 'wf-1/task-a').member.id).toBe('remote-a');
  });

  it('re-admits a member immediately on a successful start', () => {
    const runner = makeRunner();
    runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('broken pipe'));

    expect(runner.recordPoolMemberStartSuccess('ssh:remote-a')).toBe(true);
    expect(runner.recordPoolMemberStartSuccess('ssh:remote-a')).toBe(false);
    expect(runner.getPoolMemberHealthSnapshot()).toHaveLength(0);
  });

  it('backs off further on each consecutive failure', () => {
    const runner = makeRunner();
    const first = runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('exit=255'));
    const second = runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('exit=255'));

    expect(first.consecutiveFailures).toBe(1);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
  });

  it('defers with a down reason when every member is out of rotation', () => {
    const runner = makeRunner({
      strategy: 'roundRobin',
      members: [
        { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
        { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
      ],
    });
    runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('connection reset'));
    runner.recordPoolMemberTransportFailure('ssh:remote-b', new Error('connection reset'));

    expect(() => runner.selectExecutor(makeTask('wf-1/task-a'))).toThrow(/no member capacity/);
    try {
      runner.selectExecutor(makeTask('wf-1/task-a'));
    } catch (err) {
      expect((err as Error).cause).toBeInstanceOf(ResourceLimitError);
      expect((err as Error).message).toMatch(/down \d+s/);
    }
  });

  it('snapshot excludes members whose cooldown has already elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'));
    const runner = makeRunner();
    const health = runner.recordPoolMemberTransportFailure('ssh:remote-a', new Error('operation timed out'));

    vi.setSystemTime(new Date(health.downUntil + 1));
    expect(runner.getPoolMemberHealthSnapshot()).toHaveLength(0);
  });
});
