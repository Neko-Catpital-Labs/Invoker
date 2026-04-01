export const SUPPORTED_FAMILIAR_TYPES = new Set([
  'worktree', 'docker', 'ssh',
  'merge',  // internal: merge-node only
]);

/**
 * Normalizes familiarType values. Throws for unknown types.
 */
export function normalizeFamiliarType(familiarType: string | undefined): string | undefined {
  if (familiarType === undefined) return undefined;
  if (!SUPPORTED_FAMILIAR_TYPES.has(familiarType)) {
    throw new Error(
      `Unknown familiarType "${familiarType}". ` +
      `Supported values: ${[...SUPPORTED_FAMILIAR_TYPES].filter(t => t !== 'merge').join(', ')}`
    );
  }
  return familiarType;
}
