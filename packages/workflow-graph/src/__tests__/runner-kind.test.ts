import { describe, it, expect } from 'vitest';
import { normalizeRunnerKind, SUPPORTED_EXECUTOR_TYPES } from '../runner-kind.js';

describe('normalizeRunnerKind', () => {
  it('passes through valid values', () => {
    expect(normalizeRunnerKind('worktree')).toBe('worktree');
    expect(normalizeRunnerKind('docker')).toBe('docker');
    expect(normalizeRunnerKind('ssh')).toBe('ssh');
    expect(normalizeRunnerKind(undefined)).toBeUndefined();
  });

  it('passes through internal merge type', () => {
    expect(normalizeRunnerKind('merge')).toBe('merge');
  });

  it('throws for unknown runnerKind', () => {
    expect(() => normalizeRunnerKind('kubernetes')).toThrow('Unknown runnerKind "kubernetes"');
    expect(() => normalizeRunnerKind('local')).toThrow('Unknown runnerKind "local"');
    expect(() => normalizeRunnerKind('')).toThrow('Unknown runnerKind ""');
  });
});

describe('SUPPORTED_EXECUTOR_TYPES', () => {
  it('contains expected values', () => {
    expect(SUPPORTED_EXECUTOR_TYPES.has('worktree')).toBe(true);
    expect(SUPPORTED_EXECUTOR_TYPES.has('docker')).toBe(true);
    expect(SUPPORTED_EXECUTOR_TYPES.has('ssh')).toBe(true);
    expect(SUPPORTED_EXECUTOR_TYPES.has('merge')).toBe(true);
  });

  it('does not contain banned or unknown values', () => {
    expect(SUPPORTED_EXECUTOR_TYPES.has('local')).toBe(false);
    expect(SUPPORTED_EXECUTOR_TYPES.has('kubernetes')).toBe(false);
  });
});
