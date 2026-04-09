export const SUPPORTED_EXECUTOR_TYPES = new Set([
  'worktree', 'docker', 'ssh',
  'merge',  // internal: merge-node only
]);

/**
 * Normalizes executorType values. Throws for unknown types.
 */
export function normalizeExecutorType(executorType: string | undefined): string | undefined {
  if (executorType === undefined) return undefined;
  if (!SUPPORTED_EXECUTOR_TYPES.has(executorType)) {
    throw new Error(
      `Unknown executorType "${executorType}". ` +
      `Supported values: ${[...SUPPORTED_EXECUTOR_TYPES].filter(t => t !== 'merge').join(', ')}`
    );
  }
  return executorType;
}
