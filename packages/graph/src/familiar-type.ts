/**
 * Maps legacy executor ids to current ones. Persisted tasks may still store "local".
 */
export function normalizeFamiliarType(familiarType: string | undefined): string | undefined {
  if (familiarType === 'local') return 'worktree';
  return familiarType;
}
