import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  assertExecutionCapacityInvariant,
  computeConfiguredExecutionCapacity,
  fillableExecutionCapacity,
  resolveClampedMaxConcurrency,
  resolveEffectiveMaxConcurrency,
  shouldFatalOnExecutionCapacityOvercommit,
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

  it('computes capacity from SSH pool members', () => {
    expect(computeConfiguredExecutionCapacity({
      executionPools: {
        ssh: {
          members: [
            { type: 'ssh', id: 'a' },
            { type: 'ssh', id: 'b' },
            { type: 'ssh', id: 'c' },
            { type: 'ssh', id: 'd' },
          ],
        },
      },
    })).toBe(4);
    expect(() => assertExecutionCapacityInvariant({
      config: {
        executionPools: {
          ssh: {
            members: [
              { type: 'ssh', id: 'a' },
              { type: 'ssh', id: 'b' },
              { type: 'ssh', id: 'c' },
              { type: 'ssh', id: 'd' },
            ],
          },
        },
      },
      activeExecutions: 5,
    })).toThrow(/configured capacity=4/);
  });

  it('does not double count the same member across overlapping pools', () => {
    expect(computeConfiguredExecutionCapacity({
      executionPools: {
        one: { members: [{ type: 'ssh', id: 'shared' }, { type: 'ssh', id: 'a' }] },
        two: { members: [{ type: 'ssh', id: 'shared' }, { type: 'ssh', id: 'b' }] },
      },
    })).toBe(3);
  });

  it('uses the max capacity for a repeated member instead of summing', () => {
    expect(computeConfiguredExecutionCapacity({
      executionPools: {
        one: { maxConcurrentTasksPerMember: 2, members: [{ type: 'ssh', id: 'shared' }] },
        two: { maxConcurrentTasksPerMember: 4, members: [{ type: 'ssh', id: 'shared' }] },
      },
    })).toBe(4);
  });

  it('counts worktree member maxConcurrentTasks', () => {
    expect(computeConfiguredExecutionCapacity({
      executionPools: {
        worktree: { members: [{ type: 'worktree', id: 'local', maxConcurrentTasks: 12 }] },
      },
    })).toBe(12);
  });

  it('falls back to top-level maxConcurrency when no execution pools exist', () => {
    expect(computeConfiguredExecutionCapacity({ maxConcurrency: 7 })).toBe(7);
  });

  it('keeps fatal capacity checks disabled unless opted in', () => {
    expect(shouldFatalOnExecutionCapacityOvercommit({})).toBe(false);
    expect(shouldFatalOnExecutionCapacityOvercommit({
      INVOKER_FATAL_ON_EXECUTION_CAPACITY_OVERCOMMIT: '1',
    })).toBe(true);
  });

  it('clamps maxConcurrency down to configured pool capacity', () => {
    const config = {
      maxConcurrency: 13,
      executionPools: {
        mixed: {
          maxConcurrentTasksPerMember: 1,
          members: [
            { type: 'ssh' as const, id: 'a' },
            { type: 'ssh' as const, id: 'b' },
            { type: 'worktree' as const, id: 'local', maxConcurrentTasks: 6 },
          ],
        },
      },
    };
    // 2 SSH + 6 worktree = 8
    expect(computeConfiguredExecutionCapacity(config)).toBe(8);
    expect(resolveClampedMaxConcurrency(config)).toBe(8);
    expect(fillableExecutionCapacity(config)).toBe(8);
  });

  it('does not raise concurrency when pool capacity exceeds maxConcurrency', () => {
    expect(resolveClampedMaxConcurrency({
      maxConcurrency: 4,
      executionPools: {
        ssh: {
          members: [
            { type: 'ssh', id: 'a' },
            { type: 'ssh', id: 'b' },
            { type: 'ssh', id: 'c' },
            { type: 'ssh', id: 'd' },
            { type: 'ssh', id: 'e' },
          ],
        },
      },
    })).toBe(4);
  });

  it('preserves maxConcurrency when no pools are configured', () => {
    expect(resolveClampedMaxConcurrency({ maxConcurrency: 13 })).toBe(13);
  });
});
