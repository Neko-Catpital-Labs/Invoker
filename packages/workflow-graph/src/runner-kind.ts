/** All executor types accepted at runtime (includes internal 'merge'). */
export type RunnerKind = 'worktree' | 'docker' | 'ssh' | 'merge';

export const SUPPORTED_EXECUTOR_TYPES = new Set<RunnerKind>([
  'worktree', 'docker', 'ssh',
  'merge',  // internal: merge-node only
]);

/**
 * Normalizes runnerKind values. Throws for unknown types.
 */
export function normalizeRunnerKind(runnerKind: string | undefined): RunnerKind | undefined {
  if (runnerKind === undefined) return undefined;
  if (!SUPPORTED_EXECUTOR_TYPES.has(runnerKind as RunnerKind)) {
    throw new Error(
      `Unknown runnerKind "${runnerKind}". ` +
      `Supported values: ${[...SUPPORTED_EXECUTOR_TYPES].filter(t => t !== 'merge').join(', ')}`
    );
  }
  return runnerKind as RunnerKind;
}
