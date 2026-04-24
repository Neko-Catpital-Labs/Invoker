import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  resolveEffectiveMaxConcurrency,
} from '../execution-capacity.js';

describe('execution-capacity', () => {
  it('caps configured concurrency at worktree capacity', () => {
    expect(resolveEffectiveMaxConcurrency(26, 5)).toBe(5);
  });

  it('preserves a lower configured concurrency', () => {
    expect(resolveEffectiveMaxConcurrency(4, 5)).toBe(4);
  });

  it('falls back to safe defaults for invalid values', () => {
    expect(resolveEffectiveMaxConcurrency(undefined, DEFAULT_WORKTREE_MAX_CONCURRENCY)).toBe(3);
    expect(resolveEffectiveMaxConcurrency(0, 0)).toBe(3);
  });
});
