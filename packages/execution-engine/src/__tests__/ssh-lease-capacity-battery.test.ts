import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';

/**
 * Required gate for durable SSH lease capacity (stack slice 5).
 * Run via: bash scripts/repro/repro-ssh-lease-capacity-battery.sh --gate
 */

const SHARED_HOST = {
  host: 'shared.example.com',
  user: 'invoker',
  sshKeyPath: '/tmp/fake-shared',
};

const HOST_A = { host: 'a.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-a' };
const HOST_B = { host: 'b.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-b' };
const HOST_C = { host: 'c.example.com', user: 'invoker', sshKeyPath: '/tmp/fake-c' };

function makeTask(id: string, poolId: string, attempt = `${id}-attempt`): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId },
    execution: { selectedAttemptId: attempt, generation: 0 },
  } as TaskState;
}

function makeSshExecutor() {
  const completeByTaskId = new Map<string, (response: unknown) => void>();
  const executor = {
    type: 'ssh' as const,
    start: vi.fn(async (request: { actionId: string }) => ({
      executionId: `exec-${request.actionId}`,
      taskId: request.actionId,
      workspacePath: `/remote/${request.actionId}`,
    })),
    onComplete: vi.fn((handle: { taskId: string }, cb: (response: unknown) => void) => {
      completeByTaskId.set(handle.taskId, cb);
    }),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn(),
    completeByTaskId,
  };
  return executor;
}

function bindLeasePersistence(adapter: SQLiteAdapter) {
  return {
    logEvent: vi.fn(),
    updateTask: vi.fn(),
    updateAttempt: vi.fn(),
    appendTaskOutput: vi.fn(),
    claimExecutionResourceLease: adapter.claimExecutionResourceLease.bind(adapter),
    renewExecutionResourceLease: adapter.renewExecutionResourceLease.bind(adapter),
    releaseExecutionResourceLease: adapter.releaseExecutionResourceLease.bind(adapter),
    countExecutionResourceLeases: adapter.countExecutionResourceLeases.bind(adapter),
    listExecutionResourceLeases: adapter.listExecutionResourceLeases.bind(adapter),
    listExecutionResourceLeasesByKey: adapter.listExecutionResourceLeasesByKey.bind(adapter),
  };
}

function makePoolRunner(opts: {
  persistence: ReturnType<typeof bindLeasePersistence>;
  sshExecutor?: ReturnType<typeof makeSshExecutor>;
  orchestrator?: unknown;
  pools?: 'dual-shared' | 'triple-hosts';
}): TaskRunner {
  const sshExecutor = opts.sshExecutor ?? makeSshExecutor();
  const dualShared = opts.pools !== 'triple-hosts';
  return new TaskRunner({
    orchestrator: opts.orchestrator ?? {
      getTask: () => null,
      getAllTasks: () => [],
      deferTask: vi.fn(),
      markTaskRunningAfterLaunch: () => true,
      handleWorkerResponse: () => [],
    },
    persistence: opts.persistence,
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => (type === 'ssh' ? sshExecutor : null),
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as never,
    cwd: '/tmp',
    remoteTargetsProvider: () => (
      dualShared
        ? { 'remote-shared': SHARED_HOST }
        : {
            'remote-a': HOST_A,
            'remote-b': HOST_B,
            'remote-c': HOST_C,
          }
    ),
    executionPoolsProvider: () => (
      dualShared
        ? {
            'mixed-local-ssh': {
              selectionStrategy: 'leastLoaded',
              maxConcurrentTasksPerMember: 1,
              members: [{ id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 }],
            },
            'pnpm-ssh': {
              selectionStrategy: 'leastLoaded',
              maxConcurrentTasksPerMember: 1,
              members: [{ id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 }],
            },
          }
        : {
            'pnpm-ssh': {
              selectionStrategy: 'leastLoaded',
              maxConcurrentTasksPerMember: 1,
              members: [
                { id: 'remote-a', type: 'ssh', maxConcurrentTasks: 1 },
                { id: 'remote-b', type: 'ssh', maxConcurrentTasks: 1 },
                { id: 'remote-c', type: 'ssh', maxConcurrentTasks: 1 },
              ],
            },
          }
    ),
  } as never);
}

function liveLeases(adapter: SQLiteAdapter) {
  const now = new Date().toISOString();
  return adapter.listExecutionResourceLeases().filter((lease) => lease.leaseExpiresAt > now);
}

describe('SSH lease capacity battery', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('orphan memory does not wedge while leases are empty', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const ghost = makeTask('wf-ghost/task', 'pnpm-ssh', 'wf-ghost/task-live');
    ghost.status = 'running';
    const waiter = makeTask('wf-waiter/task', 'pnpm-ssh');
    const sshExecutor = makeSshExecutor();
    const runner = makePoolRunner({
      pools: 'dual-shared',
      sshExecutor,
      persistence: bindLeasePersistence(adapter),
      orchestrator: {
        getTask: (id: string) => (id === ghost.id ? ghost : id === waiter.id ? waiter : null),
        getAllTasks: () => [ghost, waiter],
        deferTask: vi.fn(),
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: () => [],
      },
    });

    (runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.set(
      'wf-ghost/task-live',
      {
        handle: { attemptId: 'wf-ghost/task-live', taskId: ghost.id },
        executor: sshExecutor,
        taskId: ghost.id,
        poolId: 'pnpm-ssh',
        poolMemberKey: 'ssh:remote-shared',
      },
    );

    expect(liveLeases(adapter)).toHaveLength(0);
    expect(() => runner.selectExecutor(waiter)).not.toThrow();
    expect(liveLeases(adapter).length).toBeGreaterThanOrEqual(1);
  });

  it('enforces cross-pool host exclusivity at maxConcurrentTasksPerMember=1', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const runner = makePoolRunner({
      pools: 'dual-shared',
      persistence: bindLeasePersistence(adapter),
    });

    expect(() => runner.selectExecutor(makeTask('wf-1/a', 'mixed-local-ssh'))).not.toThrow();
    expect(() => runner.selectExecutor(makeTask('wf-2/b', 'pnpm-ssh'))).toThrow(/no member capacity/);
    expect(liveLeases(adapter)).toHaveLength(1);
    expect(liveLeases(adapter)[0]?.resourceKey).toBe('ssh:invoker@shared.example.com:22');
  });

  it('fills expectedCap after recreate/preempt-style churn with ready work remaining', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const expectedCap = 3;
    const tasks = Array.from({ length: 12 }, (_, i) => makeTask(`wf-${i}/t0`, 'pnpm-ssh'));
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const sshExecutor = makeSshExecutor();
    const deferTask = vi.fn();
    const runner = makePoolRunner({
      pools: 'triple-hosts',
      sshExecutor,
      persistence: bindLeasePersistence(adapter),
      orchestrator: {
        getTask: (id: string) => taskMap.get(id) ?? null,
        getAllTasks: () => [...taskMap.values()],
        deferTask,
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: () => [],
      },
    });

    const runs: Promise<void>[] = [];
    for (let i = 0; i < expectedCap; i += 1) {
      runs.push(runner.executeTask(tasks[i]!));
    }
    await vi.waitFor(() => expect(sshExecutor.start).toHaveBeenCalledTimes(expectedCap));
    expect(liveLeases(adapter)).toHaveLength(expectedCap);

    // Overwhelm remaining ready work so at least one waiter defers while full.
    for (let i = expectedCap; i < expectedCap + 3; i += 1) {
      void runner.executeTask(tasks[i]!);
    }
    await vi.waitFor(() => expect(deferTask).toHaveBeenCalled());

    // Supersede first slot: new attempt id, kill old execution, inject a lease-less
    // ghost, then confirm a deferred waiter can still refill to expectedCap.
    const victim = tasks[0]!;
    const oldAttempt = victim.execution.selectedAttemptId!;
    victim.execution = { ...victim.execution, selectedAttemptId: `${victim.id}-retry` };
    expect(await runner.killActiveExecution(victim.id)).toBe(true);
    sshExecutor.completeByTaskId.get(victim.id)?.({
      requestId: 'kill',
      actionId: victim.id,
      attemptId: oldAttempt,
      status: 'failed',
      outputs: { exitCode: 130 },
    });
    await runs[0];
    expect(liveLeases(adapter)).toHaveLength(expectedCap - 1);

    (runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.set(
      'ghost-attempt',
      {
        handle: { attemptId: 'ghost-attempt', taskId: 'ghost/task' },
        executor: sshExecutor,
        taskId: 'ghost/task',
        poolId: 'pnpm-ssh',
        poolMemberKey: 'ssh:remote-a',
      },
    );

    const startsBeforeRefill = sshExecutor.start.mock.calls.length;
    const refillTask = tasks[expectedCap + 3]!;
    const refillRun = runner.executeTask(refillTask);
    await vi.waitFor(() => expect(sshExecutor.start.mock.calls.length).toBe(startsBeforeRefill + 1));
    expect(liveLeases(adapter)).toHaveLength(expectedCap);

    for (const task of [tasks[1], tasks[2], refillTask]) {
      sshExecutor.completeByTaskId.get(task!.id)?.({
        requestId: `done-${task!.id}`,
        actionId: task!.id,
        attemptId: task!.execution.selectedAttemptId,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
    }
    await Promise.all([runs[1], runs[2], refillRun]);
    expect(liveLeases(adapter)).toHaveLength(0);
  }, 60_000);

  it('keeps lease/occupancy parity for executing SSH tasks', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const tasks = [
      makeTask('wf-1/a', 'pnpm-ssh'),
      makeTask('wf-2/b', 'pnpm-ssh'),
      makeTask('wf-3/c', 'pnpm-ssh'),
    ];
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const sshExecutor = makeSshExecutor();
    const runner = makePoolRunner({
      pools: 'triple-hosts',
      sshExecutor,
      persistence: bindLeasePersistence(adapter),
      orchestrator: {
        getTask: (id: string) => taskMap.get(id) ?? null,
        getAllTasks: () => [...taskMap.values()],
        deferTask: vi.fn(),
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: () => [],
      },
    });

    const runs = tasks.map((task) => runner.executeTask(task));
    await vi.waitFor(() => expect(sshExecutor.start).toHaveBeenCalledTimes(3));

    const leases = liveLeases(adapter);
    expect(leases).toHaveLength(3);
    const leasedTaskIds = new Set(leases.map((lease) => lease.taskId));
    for (const task of tasks) {
      expect(leasedTaskIds.has(task.id)).toBe(true);
    }

    for (const task of tasks) {
      sshExecutor.completeByTaskId.get(task.id)?.({
        requestId: `done-${task.id}`,
        actionId: task.id,
        attemptId: task.execution.selectedAttemptId,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
    }
    await Promise.all(runs);
    expect(liveLeases(adapter)).toHaveLength(0);
  });
});
