/**
 * Canonical merge modes stored in persistence and consumed by the merge executor.
 */
export type CanonicalMergeMode = 'manual' | 'automatic' | 'external_review';

const VALID_INPUT = new Set(['manual', 'automatic', 'external_review']);

/**
 * Normalize user-facing merge mode strings for workflow persistence.
 * @throws if the value is not a known merge mode label
 */
export function normalizeMergeModeForPersistence(raw: string): CanonicalMergeMode {
  if (!VALID_INPUT.has(raw)) {
    throw new Error(
      `Invalid mergeMode: "${raw}". Expected one of: ${[...VALID_INPUT].join(', ')}`,
    );
  }
  if (raw === 'external_review') return 'external_review';
  if (raw === 'automatic') return 'automatic';
  return 'manual';
}
