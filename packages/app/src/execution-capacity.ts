const DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY = 3;
export const DEFAULT_WORKTREE_MAX_CONCURRENCY = 5;

export function resolveEffectiveMaxConcurrency(
  configuredMaxConcurrency: number | undefined,
  worktreeMaxConcurrency: number = DEFAULT_WORKTREE_MAX_CONCURRENCY,
): number {
  const normalizedConfigured =
    Number.isInteger(configuredMaxConcurrency) && Number(configuredMaxConcurrency) > 0
      ? Number(configuredMaxConcurrency)
      : DEFAULT_ORCHESTRATOR_MAX_CONCURRENCY;

  const normalizedWorktreeMax =
    Number.isInteger(worktreeMaxConcurrency) && Number(worktreeMaxConcurrency) > 0
      ? Number(worktreeMaxConcurrency)
      : DEFAULT_WORKTREE_MAX_CONCURRENCY;

  return Math.min(normalizedConfigured, normalizedWorktreeMax);
}
