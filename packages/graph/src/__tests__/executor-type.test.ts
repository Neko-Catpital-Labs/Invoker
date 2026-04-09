import { describe, it, expect } from 'vitest';
import { normalizeExecutorType, SUPPORTED_EXECUTOR_TYPES } from '../executor-type.js';

describe('normalizeExecutorType', () => {
  it('passes through valid values', () => {
    expect(normalizeExecutorType('worktree')).toBe('worktree');
    expect(normalizeExecutorType('docker')).toBe('docker');
    expect(normalizeExecutorType('ssh')).toBe('ssh');
    expect(normalizeExecutorType(undefined)).toBeUndefined();
  });

  it('passes through internal merge type', () => {
    expect(normalizeExecutorType('merge')).toBe('merge');
  });

  it('throws for unknown executorType', () => {
    expect(() => normalizeExecutorType('kubernetes')).toThrow('Unknown executorType "kubernetes"');
    expect(() => normalizeExecutorType('local')).toThrow('Unknown executorType "local"');
    expect(() => normalizeExecutorType('')).toThrow('Unknown executorType ""');
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
