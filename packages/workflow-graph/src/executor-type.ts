/** All executor types accepted at runtime (includes internal 'merge'). */
export type ExecutorType = 'worktree' | 'docker' | 'ssh' | 'merge';

export const SUPPORTED_EXECUTOR_TYPES = new Set<ExecutorType>([
  'worktree', 'docker', 'ssh',
  'merge',  // internal: merge-node only
]);

/**
 * Normalizes executorType values. Throws for unknown types.
 */
export function normalizeExecutorType(executorType: string | undefined): ExecutorType | undefined {
  if (executorType === undefined) return undefined;
  if (!SUPPORTED_EXECUTOR_TYPES.has(executorType as ExecutorType)) {
    throw new Error(
      `Unknown executorType "${executorType}". ` +
      `Supported values: ${[...SUPPORTED_EXECUTOR_TYPES].filter(t => t !== 'merge').join(', ')}`
    );
  }
  return executorType as ExecutorType;
}
