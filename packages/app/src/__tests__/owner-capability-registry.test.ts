import { describe, expect, it, vi } from 'vitest';
import { OwnerCapabilityRegistry } from '../owner-capability-registry.js';

describe('OwnerCapabilityRegistry', () => {
  it('registers, reports, and invokes a capability with its original arguments and result', async () => {
    const registry = new OwnerCapabilityRegistry();
    const handler = vi.fn(async (left: unknown, right: unknown) => ({ left, right }));

    registry.register('workflow.update', handler);

    expect(registry.has('workflow.update')).toBe(true);
    await expect(registry.invoke('workflow.update', ['a', 2])).resolves.toEqual({ left: 'a', right: 2 });
    expect(handler).toHaveBeenCalledWith('a', 2);
  });

  it('keeps map replacement semantics when a capability is registered again', async () => {
    const registry = new OwnerCapabilityRegistry();
    registry.register('workflow.update', async () => 'first');
    registry.register('workflow.update', async () => 'second');

    await expect(registry.invoke('workflow.update')).resolves.toBe('second');
  });

  it('reports and rejects an unregistered capability', async () => {
    const registry = new OwnerCapabilityRegistry();

    expect(registry.has('missing')).toBe(false);
    await expect(registry.invoke('missing')).rejects.toThrow('No owner capability registered for missing');
  });

  it('preserves handler failures', async () => {
    const registry = new OwnerCapabilityRegistry();
    const failure = new Error('mutation failed');
    registry.register('workflow.update', async () => { throw failure; });

    await expect(registry.invoke('workflow.update')).rejects.toBe(failure);
  });
});
