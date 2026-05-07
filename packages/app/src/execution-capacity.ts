const DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY = 6;
export const DEFAULT_WORKTREE_MAX_CONCURRENCY = DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY;

export function resolveEffectiveMaxConcurrency(
  configuredMaxConcurrency: number | undefined,
): number {
  return Number.isInteger(configuredMaxConcurrency) && Number(configuredMaxConcurrency) > 0
    ? Number(configuredMaxConcurrency)
    : DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY;
}
