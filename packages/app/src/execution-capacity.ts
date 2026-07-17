const DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY = 6;
export const DEFAULT_WORKTREE_MAX_CONCURRENCY = DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY;

type ExecutionPoolMember =
  | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
  | { type: 'worktree'; id: string; maxConcurrentTasks?: number };

type ExecutionPoolConfig = {
  members?: ExecutionPoolMember[];
  maxConcurrentTasksPerMember?: number;
};

export type ExecutionCapacityConfig = {
  maxConcurrency?: number;
  executionPools?: Record<string, ExecutionPoolConfig>;
};

export function resolveEffectiveMaxConcurrency(
  configuredMaxConcurrency: number | undefined,
): number {
  return Number.isInteger(configuredMaxConcurrency) && Number(configuredMaxConcurrency) > 0
    ? Number(configuredMaxConcurrency)
    : DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY;
}

/**
 * Scheduler concurrency must not exceed configured pool hardware capacity.
 * When pools are configured, clamp `maxConcurrency` down so the UI / drain
 * loop cannot promise more slots than members can run.
 */
export function resolveClampedMaxConcurrency(config: ExecutionCapacityConfig): number {
  const requested = resolveEffectiveMaxConcurrency(config.maxConcurrency);
  const pools = config.executionPools ?? {};
  if (Object.keys(pools).length === 0) {
    return requested;
  }
  const poolCapacity = computeConfiguredExecutionCapacity(config);
  if (!Number.isInteger(poolCapacity) || poolCapacity <= 0) {
    return requested;
  }
  return Math.min(requested, poolCapacity);
}

export function fillableExecutionCapacity(config: ExecutionCapacityConfig): number {
  return resolveClampedMaxConcurrency(config);
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

export function computeConfiguredExecutionCapacity(config: ExecutionCapacityConfig): number {
  const pools = config.executionPools ?? {};
  const poolEntries = Object.values(pools);
  if (poolEntries.length === 0) {
    return resolveEffectiveMaxConcurrency(config.maxConcurrency);
  }

  const capacityByResource = new Map<string, number>();
  for (const pool of poolEntries) {
    for (const member of pool.members ?? []) {
      const resourceKey = `${member.type}:${member.id}`;
      const capacity = member.type === 'ssh'
        ? positiveIntegerOrUndefined(member.maxConcurrentTasks)
          ?? positiveIntegerOrUndefined(pool.maxConcurrentTasksPerMember)
          ?? 1
        : positiveIntegerOrUndefined(member.maxConcurrentTasks) ?? 1;
      capacityByResource.set(resourceKey, Math.max(capacityByResource.get(resourceKey) ?? 0, capacity));
    }
  }

  return [...capacityByResource.values()].reduce((sum, capacity) => sum + capacity, 0);
}

export function shouldFatalOnExecutionCapacityOvercommit(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INVOKER_FATAL_ON_EXECUTION_CAPACITY_OVERCOMMIT === '1';
}

export function assertExecutionCapacityInvariant(input: {
  config: ExecutionCapacityConfig;
  activeExecutions: number;
  label?: string;
}): void {
  const capacity = computeConfiguredExecutionCapacity(input.config);
  if (input.activeExecutions <= capacity) return;
  throw new Error(
    `FATAL: Invoker execution capacity invariant violated` +
    `${input.label ? ` (${input.label})` : ''}: ` +
    `active/launching executions=${input.activeExecutions}, configured capacity=${capacity}`,
  );
}
