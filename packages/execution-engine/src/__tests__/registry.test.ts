import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from '../registry.js';
import type { Familiar } from '../executor.js';

const stubExecutor = (type: string): Executor => ({
  type,
  start: async () => ({ executionId: '', taskId: '' }),
  kill: async () => {},
  sendInput: () => {},
  onOutput: () => () => {},
  onComplete: () => () => {},
  getTerminalSpec: () => null,
  destroyAll: async () => {},
});

describe('ExecutorRegistry', () => {
  let registry: ExecutorRegistry;

  beforeEach(() => {
    registry = new ExecutorRegistry();
  });

  it('register + get returns executor', () => {
    const executor = stubExecutor('worktree');
    registry.register('worktree', executor);

    const result = registry.get('worktree');
    expect(result).toBe(executor);
  });

  it('getDefault returns worktree executor', () => {
    const worktree = stubExecutor('worktree');
    registry.register('worktree', worktree);

    const result = registry.getDefault();
    expect(result).toBe(worktree);
  });

  it('getDefault throws when worktree executor not registered', () => {
    expect(() => registry.getDefault()).toThrow('No "worktree" executor registered. Register one before calling getDefault().');
  });

  it('get returns undefined for unknown type', () => {
    const result = registry.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('getAll returns all registered familiars', () => {
    const worktree = stubExecutor('worktree');
    const docker = stubExecutor('docker');

    registry.register('worktree', worktree);
    registry.register('docker', docker);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(worktree);
    expect(all).toContain(docker);
  });

  it('getAll returns empty array when no familiars registered', () => {
    const all = registry.getAll();
    expect(all).toEqual([]);
  });
});
