import { ResourceLimitError } from './repo-pool.js';

export type ExecutionPoolMember =
  | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
  | { type: 'worktree'; id: string; maxConcurrentTasks?: number };

export type ExecutionPoolConfig = {
  members: ExecutionPoolMember[];
  selectionStrategy?: 'roundRobin' | 'leastLoaded';
  maxConcurrentTasksPerMember?: number;
};

export type RemoteTargetDisplay = {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  maxConcurrentTasks?: number;
  managedWorkspaces?: boolean;
  remoteInvokerHome?: string;
  provisionCommand?: string;
  remoteHeartbeatIntervalSeconds?: number;
};

export type ExecutionResourceLeaseHandle = {
  resourceKey: string;
  holderId: string;
  capacity: number;
  poolId?: string;
  poolMemberId?: string;
};

export type ExecutionPoolAllocation = {
  poolId: string;
  member: ExecutionPoolMember;
  memberKey: string;
  physicalKey: string;
  resourceKey?: string;
  capacity?: number;
  resourceLease?: ExecutionResourceLeaseHandle;
  selectionStrategy: 'roundRobin' | 'leastLoaded';
  memberIndex: number;
};

export type ActiveExecutionResource = {
  poolId?: string;
  poolMemberKey?: string;
  resourceLease?: Pick<ExecutionResourceLeaseHandle, 'resourceKey'>;
};

export type ExecutionPoolAllocatorState = {
  roundRobinCursor?: number;
};

export type ClaimExecutionResourceLease = (lease: ExecutionResourceLeaseHandle) => boolean;

export type ExecutionPoolAllocationRequest = {
  poolId: string;
  taskId: string;
  attemptId?: string;
  pool: ExecutionPoolConfig;
  pools: Record<string, ExecutionPoolConfig>;
  remoteTargets: Record<string, RemoteTargetDisplay>;
  activeLocalExecutions: Iterable<ActiveExecutionResource>;
  pendingAllocations?: Iterable<ExecutionPoolAllocation>;
  state?: ExecutionPoolAllocatorState;
  claimExecutionResourceLease?: ClaimExecutionResourceLease;
};

export type PoolCapacityBlockedDetails = {
  poolId: string;
  poolMemberId?: string;
  resourceKey?: string;
  capacity?: number;
};

export class PoolCapacityUnavailableError extends ResourceLimitError {
  details: PoolCapacityBlockedDetails;

  constructor(message: string, details: PoolCapacityBlockedDetails) {
    super(message);
    this.name = 'PoolCapacityUnavailableError';
    this.details = details;
  }
}

export function sshResourceKeyForTarget(target: Pick<RemoteTargetDisplay, 'user' | 'host' | 'port'>): string {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

export function poolMemberKey(member: ExecutionPoolMember): string {
  return `${member.type}:${member.id}`;
}

function positiveLimit(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : undefined;
}

function poolMemberPhysicalKey(
  member: ExecutionPoolMember,
  remoteTargets: Record<string, RemoteTargetDisplay>,
): string {
  if (member.type !== 'ssh') return poolMemberKey(member);
  const target = remoteTargets[member.id];
  return target ? sshResourceKeyForTarget(target) : poolMemberKey(member);
}

export function resolvePoolMemberCapacity(
  member: ExecutionPoolMember,
  pool: ExecutionPoolConfig,
  pools: Record<string, ExecutionPoolConfig>,
  remoteTargets: Record<string, RemoteTargetDisplay>,
): number | undefined {
  if (member.type !== 'ssh') {
    return positiveLimit(member.maxConcurrentTasks)
      ?? positiveLimit(pool.maxConcurrentTasksPerMember);
  }

  const limits: number[] = [];
  const target = remoteTargets[member.id];
  const resourceKey = target ? sshResourceKeyForTarget(target) : undefined;
  const targetLimit = positiveLimit(target?.maxConcurrentTasks);
  if (targetLimit !== undefined) limits.push(targetLimit);

  for (const candidatePool of Object.values(pools)) {
    for (const candidate of candidatePool.members) {
      if (candidate.type !== 'ssh') continue;
      const candidateTarget = remoteTargets[candidate.id];
      const candidateKey = candidateTarget ? sshResourceKeyForTarget(candidateTarget) : undefined;
      if (resourceKey && candidateKey === resourceKey) {
        const memberLimit = positiveLimit(candidate.maxConcurrentTasks);
        if (memberLimit !== undefined) limits.push(memberLimit);
        const poolLimit = positiveLimit(candidatePool.maxConcurrentTasksPerMember);
        if (poolLimit !== undefined) limits.push(poolLimit);
      }
    }
  }

  const selectedMemberLimit = positiveLimit(member.maxConcurrentTasks);
  if (selectedMemberLimit !== undefined) limits.push(selectedMemberLimit);
  const selectedPoolLimit = positiveLimit(pool.maxConcurrentTasksPerMember);
  if (selectedPoolLimit !== undefined) limits.push(selectedPoolLimit);
  return limits.length > 0 ? Math.min(...limits) : 1;
}

function localLoad(
  physicalKey: string,
  activeLocalExecutions: Iterable<ActiveExecutionResource>,
  pendingAllocations: Iterable<ExecutionPoolAllocation> | undefined,
): number {
  let load = 0;
  for (const allocation of pendingAllocations ?? []) {
    if (allocation.physicalKey === physicalKey) load += 1;
  }
  for (const entry of activeLocalExecutions) {
    if (entry.resourceLease?.resourceKey === physicalKey || entry.poolMemberKey === physicalKey) {
      load += 1;
    }
  }
  return load;
}

function buildAllocation(
  poolId: string,
  pool: ExecutionPoolConfig,
  pools: Record<string, ExecutionPoolConfig>,
  remoteTargets: Record<string, RemoteTargetDisplay>,
  member: ExecutionPoolMember,
  memberIndex: number,
): ExecutionPoolAllocation {
  const target = member.type === 'ssh' ? remoteTargets[member.id] : undefined;
  const resourceKey = target ? sshResourceKeyForTarget(target) : undefined;
  return {
    poolId,
    member,
    memberKey: poolMemberKey(member),
    physicalKey: resourceKey ?? poolMemberPhysicalKey(member, remoteTargets),
    resourceKey,
    capacity: resolvePoolMemberCapacity(member, pool, pools, remoteTargets),
    selectionStrategy: pool.selectionStrategy ?? 'roundRobin',
    memberIndex,
  };
}

function rankedAllocations(request: ExecutionPoolAllocationRequest): ExecutionPoolAllocation[] {
  const { poolId, pool, pools, remoteTargets, activeLocalExecutions, pendingAllocations } = request;
  if (pool.members.length === 0) return [];

  if (pool.selectionStrategy === 'roundRobin') {
    const cursor = request.state?.roundRobinCursor ?? 0;
    const candidates: ExecutionPoolAllocation[] = [];
    for (let offset = 0; offset < pool.members.length; offset += 1) {
      const index = (cursor + offset) % pool.members.length;
      const allocation = buildAllocation(poolId, pool, pools, remoteTargets, pool.members[index], index);
      const load = localLoad(allocation.physicalKey, activeLocalExecutions, pendingAllocations);
      if (allocation.capacity === undefined || load < allocation.capacity) {
        candidates.push(allocation);
      }
    }
    return candidates;
  }

  return pool.members
    .map((member, index) => {
      const allocation = buildAllocation(poolId, pool, pools, remoteTargets, member, index);
      const load = localLoad(allocation.physicalKey, activeLocalExecutions, pendingAllocations);
      return {
        allocation,
        load,
        hasCapacity: allocation.capacity === undefined || load < allocation.capacity,
      };
    })
    .filter((entry) => entry.hasCapacity)
    .sort((a, b) => a.load - b.load || a.allocation.memberIndex - b.allocation.memberIndex)
    .map((entry) => entry.allocation);
}

export function allocateExecutionPoolMember(request: ExecutionPoolAllocationRequest): ExecutionPoolAllocation {
  const blocked: ExecutionPoolAllocation[] = [];

  for (const allocation of rankedAllocations(request)) {
    if (allocation.member.type !== 'ssh' || !request.attemptId || !allocation.resourceKey) {
      return allocation;
    }

    const lease: ExecutionResourceLeaseHandle = {
      resourceKey: allocation.resourceKey,
      holderId: request.attemptId,
      capacity: allocation.capacity ?? 1,
      poolId: request.poolId,
      poolMemberId: allocation.member.id,
    };
    const claimed = request.claimExecutionResourceLease?.(lease) ?? true;
    if (!claimed) {
      blocked.push(allocation);
      continue;
    }
    return { ...allocation, resourceLease: lease };
  }

  const blockedAllocation = blocked[0] ?? (request.pool.members[0]
    ? buildAllocation(request.poolId, request.pool, request.pools, request.remoteTargets, request.pool.members[0], 0)
    : undefined);
  throw new PoolCapacityUnavailableError(
    `Execution pool "${request.poolId}" has no available members`,
    {
      poolId: request.poolId,
      poolMemberId: blockedAllocation?.member.type === 'ssh' ? blockedAllocation.member.id : undefined,
      resourceKey: blockedAllocation?.resourceKey ?? blockedAllocation?.physicalKey,
      capacity: blockedAllocation?.capacity,
    },
  );
}
