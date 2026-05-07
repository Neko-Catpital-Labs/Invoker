import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  resolveEffectiveMaxConcurrency,
} from '../execution-capacity.js';

describe('execution-capacity', () => {
  it('preserves configured concurrency without applying an artificial cap', () => {
    expect(resolveEffectiveMaxConcurrency(26)).toBe(26);
  });

  it('preserves a lower configured concurrency', () => {
    expect(resolveEffectiveMaxConcurrency(4)).toBe(4);
  });

  it('falls back to safe defaults for invalid values', () => {
    expect(resolveEffectiveMaxConcurrency(undefined)).toBe(DEFAULT_WORKTREE_MAX_CONCURRENCY);
    expect(resolveEffectiveMaxConcurrency(0)).toBe(DEFAULT_WORKTREE_MAX_CONCURRENCY);
  });
});
