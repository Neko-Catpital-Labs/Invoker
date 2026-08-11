import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { acquirePoolSelectionLease, sshHostLeaseLoad } from '../task-runner-pool.js';
import type { PoolSelection } from '../task-runner-pool.js';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';

/**
 * Proof for durable SSH lease capacity authority.
 *
 * Desired end state (slices 2–4): SSH member capacity is decided by unexpired
 * `execution_resource_leases` rows (host-keyed), not by in-memory
 * `activeExecutions` / `pendingPoolSelections`.
 *
 * These tests use `it.fails` so CI stays green while the current memory-backed
 * authority still exhibits the buggy contract. Fix slices remove `.fails`.
 */

const sharedHost = {
  host: 'shared.example.com',
  user: 'invoker',
  sshKeyPath: '/tmp/fake-shared',
};

function makeSshExecutor() {
  return {
    type: 'ssh',
    start: vi.fn(),
    onComplete: vi.fn(),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn(),
  };
}

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

function makeDualPoolRunner(opts: {
  persistence?: unknown;
  orchestrator?: unknown;
  sshExecutor?: unknown;
} = {}): TaskRunner {
  const sshExecutor = opts.sshExecutor ?? makeSshExecutor();
  return new TaskRunner({
    orchestrator: opts.orchestrator ?? {
      getTask: () => null,
      getAllTasks: () => [],
      deferTask: vi.fn(),
    },
    persistence: opts.persistence ?? { logEvent: vi.fn() },
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => (type === 'ssh' ? sshExecutor : null),
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as never,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'remote-shared': sharedHost,
    }),
    executionPoolsProvider: () => ({
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
    }),
  } as never);
}

describe('SSH lease capacity authority (proof)', () => {
  // Lease-backed SSH load ignores lease-less activeExecutions ghosts.
  it('does not wedge SSH capacity on a lease-less activeExecutions ghost', () => {
    const liveTask = makeTask('wf-1/task-a', 'pnpm-ssh', 'wf-1/task-a-live');
    liveTask.status = 'running';
    const sshExecutor = makeSshExecutor();
    const runner = makeDualPoolRunner({
      sshExecutor,
      orchestrator: {
        getTask: (id: string) => (id === liveTask.id ? liveTask : null),
        getAllTasks: () => [liveTask],
        deferTask: vi.fn(),
      },
      persistence: {
        logEvent: vi.fn(),
        listExecutionResourceLeases: () => [],
        claimExecutionResourceLease: () => true,
        releaseExecutionResourceLease: vi.fn(),
      },
    });

    (runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.set(
      'wf-1/task-a-live',
      {
        handle: { attemptId: 'wf-1/task-a-live' },
        executor: sshExecutor,
        taskId: liveTask.id,
        poolId: 'pnpm-ssh',
        poolMemberKey: 'ssh:remote-shared',
      },
    );

    expect((runner as any).persistence.listExecutionResourceLeases()).toEqual([]);
    expect(() => runner.selectExecutor(makeTask('wf-2/task-b', 'pnpm-ssh'))).not.toThrow();
  });

  // sshHostLeaseLoad is the durable-lease authority: it must return the
  // persisted lease count, not the size of any in-memory activeExecutions map.
  it('sshHostLeaseLoad returns the durable lease count, not activeExecutions size', () => {
    const countExecutionResourceLeases = vi.fn().mockReturnValue(3);
    const host = {
      getRemoteTargets: () => ({ 'remote-shared': sharedHost }),
      persistence: {
        countExecutionResourceLeases,
      },
      activeExecutions: new Map([
        ['ghost-attempt', { poolId: 'pnpm-ssh', poolMemberKey: 'ssh:remote-shared' }],
      ]),
    } as unknown as Parameters<typeof sshHostLeaseLoad>[0];

    const load = sshHostLeaseLoad(host, { type: 'ssh', id: 'remote-shared' });

    expect(load).toBe(3);
    expect(countExecutionResourceLeases).toHaveBeenCalledWith('ssh:invoker@shared.example.com:22');
  });

  // acquirePoolSelectionLease is the claim-at-select guard itself: called
  // directly (not through selectExecutor), it must claim on a first call and
  // refuse a conflicting second claim for the same host.
  it('acquirePoolSelectionLease claims a host lease once and blocks a conflicting second claim', () => {
    const task = makeTask('wf-1/task-a', 'mixed-local-ssh');
    const claimExecutionResourceLease = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const host = {
      getRemoteTargets: () => ({ 'remote-shared': sharedHost }),
      getExecutionPools: () => ({
        'mixed-local-ssh': {
          selectionStrategy: 'leastLoaded',
          maxConcurrentTasksPerMember: 1,
          members: [{ id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 }],
        },
      }),
      runnerInstanceId: 'runner-1',
      persistence: {
        claimExecutionResourceLease,
        logEvent: vi.fn(),
      },
    } as unknown as Parameters<typeof acquirePoolSelectionLease>[0];

    const selection: PoolSelection = {
      poolId: 'mixed-local-ssh',
      member: { id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 },
      memberKey: 'ssh:remote-shared',
      selectionStrategy: 'leastLoaded',
    };
    expect(acquirePoolSelectionLease(host, task, 'wf-1/task-a-attempt-1', selection)).toBe(true);
    expect(selection.leaseResourceKey).toBe('ssh:invoker@shared.example.com:22');
    expect(selection.leaseHolderId).toBeDefined();

    const conflictingSelection: PoolSelection = {
      poolId: 'pnpm-ssh',
      member: { id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 },
      memberKey: 'ssh:remote-shared',
      selectionStrategy: 'leastLoaded',
    };
    expect(acquirePoolSelectionLease(host, task, 'wf-2/task-b-attempt-1', conflictingSelection)).toBe(false);
    expect(claimExecutionResourceLease).toHaveBeenCalledTimes(2);
  });

  // Host-keyed claim-at-select prevents two pools from double-booking one droplet.
  it('blocks a second pool from selecting a host already reserved by another pool', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const first = makeTask('wf-1/task-a', 'mixed-local-ssh');
      const second = makeTask('wf-2/task-b', 'pnpm-ssh');
      const runner = makeDualPoolRunner({
        persistence: {
          logEvent: vi.fn(),
          claimExecutionResourceLease: adapter.claimExecutionResourceLease.bind(adapter),
          renewExecutionResourceLease: adapter.renewExecutionResourceLease.bind(adapter),
          releaseExecutionResourceLease: adapter.releaseExecutionResourceLease.bind(adapter),
          listExecutionResourceLeases: adapter.listExecutionResourceLeases.bind(adapter),
        },
      });

      expect(() => runner.selectExecutor(first)).not.toThrow();
      // After claim-at-select, the first selection holds a host lease. The second
      // pool must see the shared host as full.
      expect(() => runner.selectExecutor(second)).toThrow(/no member capacity|resource-limit|lease/i);
      expect(adapter.listExecutionResourceLeases().length).toBeGreaterThanOrEqual(1);
    } finally {
      adapter.close();
    }
  });
});
