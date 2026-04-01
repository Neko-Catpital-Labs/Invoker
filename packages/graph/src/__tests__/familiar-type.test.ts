import { describe, it, expect } from 'vitest';
import { normalizeFamiliarType, SUPPORTED_FAMILIAR_TYPES } from '../familiar-type.js';

describe('normalizeFamiliarType', () => {
  it('passes through valid values', () => {
    expect(normalizeFamiliarType('worktree')).toBe('worktree');
    expect(normalizeFamiliarType('docker')).toBe('docker');
    expect(normalizeFamiliarType('ssh')).toBe('ssh');
    expect(normalizeFamiliarType(undefined)).toBeUndefined();
  });

  it('passes through internal merge type', () => {
    expect(normalizeFamiliarType('merge')).toBe('merge');
  });

  it('throws for unknown familiarType', () => {
    expect(() => normalizeFamiliarType('kubernetes')).toThrow('Unknown familiarType "kubernetes"');
    expect(() => normalizeFamiliarType('local')).toThrow('Unknown familiarType "local"');
    expect(() => normalizeFamiliarType('')).toThrow('Unknown familiarType ""');
  });
});

describe('SUPPORTED_FAMILIAR_TYPES', () => {
  it('contains expected values', () => {
    expect(SUPPORTED_FAMILIAR_TYPES.has('worktree')).toBe(true);
    expect(SUPPORTED_FAMILIAR_TYPES.has('docker')).toBe(true);
    expect(SUPPORTED_FAMILIAR_TYPES.has('ssh')).toBe(true);
    expect(SUPPORTED_FAMILIAR_TYPES.has('merge')).toBe(true);
  });

  it('does not contain banned or unknown values', () => {
    expect(SUPPORTED_FAMILIAR_TYPES.has('local')).toBe(false);
    expect(SUPPORTED_FAMILIAR_TYPES.has('kubernetes')).toBe(false);
  });
});
