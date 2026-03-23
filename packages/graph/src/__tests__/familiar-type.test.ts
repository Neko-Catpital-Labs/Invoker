import { describe, it, expect } from 'vitest';
import { normalizeFamiliarType } from '../familiar-type.js';

describe('normalizeFamiliarType', () => {
  it('maps legacy local to worktree', () => {
    expect(normalizeFamiliarType('local')).toBe('worktree');
  });

  it('passes through other values', () => {
    expect(normalizeFamiliarType('worktree')).toBe('worktree');
    expect(normalizeFamiliarType('docker')).toBe('docker');
    expect(normalizeFamiliarType(undefined)).toBeUndefined();
  });
});
