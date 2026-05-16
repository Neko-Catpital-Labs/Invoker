import { describe, expect, it } from 'vitest';
import {
  allocateExecutionPoolMember,
  PoolCapacityUnavailableError,
  type ExecutionPoolConfig,
  type RemoteTargetDisplay,
} from '../execution-pool-allocator.js';

function claimStore(seed: Record<string, string[]> = {}) {
  const leases = new Map<string, Set<string>>(
    Object.entries(seed).map(([key, holders]) => [key, new Set(holders)]),
  );
  return {
    claim: (lease: { resourceKey: string; holderId: string; capacity: number }) => {
      const holders = leases.get(lease.resourceKey) ?? new Set<string>();
      if (holders.size >= lease.capacity) return false;
      holders.add(lease.holderId);
      leases.set(lease.resourceKey, holders);
      return true;
    },
    leases,
  };
}

const targets: Record<string, RemoteTargetDisplay> = {
  remoteA: { host: 'host-a', user: 'deploy', sshKeyPath: '~/.ssh/id' },
  remoteB: { host: 'host-b', user: 'deploy', sshKeyPath: '~/.ssh/id' },
  aliasA: { host: 'host-a', user: 'deploy', sshKeyPath: '~/.ssh/id' },
};

describe('execution pool allocator', () => {
  it('selects the next SSH member when the first member is leased externally', () => {
    const pool: ExecutionPoolConfig = {
      members: [
        { type: 'ssh', id: 'remoteA' },
        { type: 'ssh', id: 'remoteB' },
      ],
      selectionStrategy: 'leastLoaded',
      maxConcurrentTasksPerMember: 1,
    };
    const store = claimStore({ 'ssh:deploy@host-a:22': ['external'] });

    const allocation = allocateExecutionPoolMember({
      poolId: 'pool-a',
      taskId: 'task-a',
      attemptId: 'attempt-a',
      pool,
      pools: { 'pool-a': pool },
      remoteTargets: targets,
      activeLocalExecutions: [],
      claimExecutionResourceLease: store.claim,
    });

    expect(allocation.member).toEqual({ type: 'ssh', id: 'remoteB' });
    expect(allocation.resourceLease).toMatchObject({
      resourceKey: 'ssh:deploy@host-b:22',
      capacity: 1,
      poolMemberId: 'remoteB',
    });
  });

  it('throws ResourceLimitError semantics when all SSH members are leased', () => {
    const pool: ExecutionPoolConfig = {
      members: [
        { type: 'ssh', id: 'remoteA' },
        { type: 'ssh', id: 'remoteB' },
      ],
      selectionStrategy: 'leastLoaded',
      maxConcurrentTasksPerMember: 1,
    };
    const store = claimStore({
      'ssh:deploy@host-a:22': ['external-a'],
      'ssh:deploy@host-b:22': ['external-b'],
    });

    expect(() => allocateExecutionPoolMember({
      poolId: 'pool-a',
      taskId: 'task-a',
      attemptId: 'attempt-a',
      pool,
      pools: { 'pool-a': pool },
      remoteTargets: targets,
      activeLocalExecutions: [],
      claimExecutionResourceLease: store.claim,
    })).toThrow(PoolCapacityUnavailableError);
  });

  it('conflicts through the same physical SSH key across pools', () => {
    const poolA: ExecutionPoolConfig = {
      members: [{ type: 'ssh', id: 'remoteA' }],
      selectionStrategy: 'leastLoaded',
    };
    const poolB: ExecutionPoolConfig = {
      members: [{ type: 'ssh', id: 'aliasA' }],
      selectionStrategy: 'leastLoaded',
    };
    const store = claimStore();
    const pools = { poolA, poolB };

    const first = allocateExecutionPoolMember({
      poolId: 'poolA',
      taskId: 'task-a',
      attemptId: 'attempt-a',
      pool: poolA,
      pools,
      remoteTargets: targets,
      activeLocalExecutions: [],
      claimExecutionResourceLease: store.claim,
    });
    expect(first.resourceLease?.resourceKey).toBe('ssh:deploy@host-a:22');

    expect(() => allocateExecutionPoolMember({
      poolId: 'poolB',
      taskId: 'task-b',
      attemptId: 'attempt-b',
      pool: poolB,
      pools,
      remoteTargets: targets,
      activeLocalExecutions: [],
      claimExecutionResourceLease: store.claim,
    })).toThrow(PoolCapacityUnavailableError);
  });

  it('least-loaded and round-robin choose members within capacity only', () => {
    const leastLoadedPool: ExecutionPoolConfig = {
      members: [
        { type: 'worktree', id: 'local-a', maxConcurrentTasks: 1 },
        { type: 'worktree', id: 'local-b', maxConcurrentTasks: 2 },
      ],
      selectionStrategy: 'leastLoaded',
    };

    const leastLoaded = allocateExecutionPoolMember({
      poolId: 'local',
      taskId: 'task-a',
      pool: leastLoadedPool,
      pools: { local: leastLoadedPool },
      remoteTargets: targets,
      activeLocalExecutions: [{ poolMemberKey: 'worktree:local-a' }],
    });
    expect(leastLoaded.member.id).toBe('local-b');

    const roundRobinPool: ExecutionPoolConfig = {
      members: [
        { type: 'worktree', id: 'local-a', maxConcurrentTasks: 1 },
        { type: 'worktree', id: 'local-b', maxConcurrentTasks: 1 },
      ],
      selectionStrategy: 'roundRobin',
    };
    const roundRobin = allocateExecutionPoolMember({
      poolId: 'local',
      taskId: 'task-b',
      pool: roundRobinPool,
      pools: { local: roundRobinPool },
      remoteTargets: targets,
      activeLocalExecutions: [{ poolMemberKey: 'worktree:local-a' }],
      state: { roundRobinCursor: 0 },
    });
    expect(roundRobin.member.id).toBe('local-b');
  });

  it('uses the minimum positive capacity for inconsistent physical SSH limits', () => {
    const remoteTargets = {
      remoteA: { ...targets.remoteA, maxConcurrentTasks: 4 },
      aliasA: targets.aliasA,
    };
    const poolA: ExecutionPoolConfig = {
      members: [{ type: 'ssh', id: 'remoteA', maxConcurrentTasks: 3 }],
      maxConcurrentTasksPerMember: 2,
      selectionStrategy: 'leastLoaded',
    };
    const poolB: ExecutionPoolConfig = {
      members: [{ type: 'ssh', id: 'aliasA', maxConcurrentTasks: 1 }],
      maxConcurrentTasksPerMember: 5,
      selectionStrategy: 'leastLoaded',
    };
    const store = claimStore();

    const allocation = allocateExecutionPoolMember({
      poolId: 'poolA',
      taskId: 'task-a',
      attemptId: 'attempt-a',
      pool: poolA,
      pools: { poolA, poolB },
      remoteTargets,
      activeLocalExecutions: [],
      claimExecutionResourceLease: store.claim,
    });

    expect(allocation.resourceLease?.capacity).toBe(1);
  });
});
