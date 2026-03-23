import { describe, it, expect, beforeEach } from 'vitest';
import { FamiliarRegistry } from '../registry.js';
import type { Familiar } from '../familiar.js';

const stubFamiliar = (type: string): Familiar => ({
  type,
  start: async () => ({ executionId: '', taskId: '' }),
  kill: async () => {},
  sendInput: () => {},
  onOutput: () => () => {},
  onComplete: () => () => {},
  getTerminalSpec: () => null,
  destroyAll: async () => {},
});

describe('FamiliarRegistry', () => {
  let registry: FamiliarRegistry;

  beforeEach(() => {
    registry = new FamiliarRegistry();
  });

  it('register + get returns familiar', () => {
    const familiar = stubFamiliar('worktree');
    registry.register('worktree', familiar);

    const result = registry.get('worktree');
    expect(result).toBe(familiar);
  });

  it('getDefault returns worktree familiar', () => {
    const worktree = stubFamiliar('worktree');
    registry.register('worktree', worktree);

    const result = registry.getDefault();
    expect(result).toBe(worktree);
  });

  it('getDefault throws when worktree familiar not registered', () => {
    expect(() => registry.getDefault()).toThrow('No "worktree" familiar registered. Register one before calling getDefault().');
  });

  it('get returns undefined for unknown type', () => {
    const result = registry.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('getAll returns all registered familiars', () => {
    const worktree = stubFamiliar('worktree');
    const docker = stubFamiliar('docker');

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
