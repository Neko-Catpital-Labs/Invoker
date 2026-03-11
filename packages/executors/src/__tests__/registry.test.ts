import { describe, it, expect, beforeEach } from 'vitest';
import { FamiliarRegistry } from '../registry.js';
import { LocalFamiliar } from '../local-familiar.js';
import type { Familiar } from '../familiar.js';

describe('FamiliarRegistry', () => {
  let registry: FamiliarRegistry;

  beforeEach(() => {
    registry = new FamiliarRegistry();
  });

  it('register + get returns familiar', () => {
    const familiar = new LocalFamiliar();
    registry.register('local', familiar);

    const result = registry.get('local');
    expect(result).toBe(familiar);
  });

  it('getDefault returns local familiar', () => {
    const familiar = new LocalFamiliar();
    registry.register('local', familiar);

    const result = registry.getDefault();
    expect(result).toBe(familiar);
  });

  it('get returns undefined for unknown type', () => {
    const result = registry.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('getAll returns all registered familiars', () => {
    const local = new LocalFamiliar();
    const docker: Familiar = {
      type: 'docker',
      start: async () => ({ executionId: '', taskId: '' }),
      kill: async () => {},
      sendInput: () => {},
      onOutput: () => () => {},
      onComplete: () => () => {},
      getTerminalSpec: () => null,
      destroyAll: async () => {},
    };

    registry.register('local', local);
    registry.register('docker', docker);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(local);
    expect(all).toContain(docker);
  });

  it('getAll returns empty array when no familiars registered', () => {
    const all = registry.getAll();
    expect(all).toEqual([]);
  });
});
