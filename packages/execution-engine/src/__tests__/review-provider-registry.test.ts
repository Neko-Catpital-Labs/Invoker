import { describe, it, expect } from 'vitest';
import { ReviewProviderRegistry } from '../review-provider-registry.js';
import type { MergeGateProvider } from '../merge-gate-provider.js';

function makeFakeProvider(name: string): MergeGateProvider {
  return {
    name,
    createReview: async () => ({ url: `https://example.com/${name}/1`, identifier: `${name}#1` }),
    checkApproval: async () => ({ approved: false, rejected: false, statusText: 'pending', url: '' }),
  };
}

describe('ReviewProviderRegistry', () => {
  it('register and get a provider', () => {
    const registry = new ReviewProviderRegistry();
    const provider = makeFakeProvider('github');
    registry.register(provider);
    expect(registry.get('github')).toBe(provider);
  });

  it('get returns undefined for unknown provider', () => {
    const registry = new ReviewProviderRegistry();
    expect(registry.get('gitlab')).toBeUndefined();
  });

  it('getOrThrow throws for unknown provider', () => {
    const registry = new ReviewProviderRegistry();
    registry.register(makeFakeProvider('github'));
    expect(() => registry.getOrThrow('gitlab')).toThrow(
      'No review provider registered with name "gitlab"',
    );
  });

  it('getOrThrow returns provider for known name', () => {
    const registry = new ReviewProviderRegistry();
    const provider = makeFakeProvider('github');
    registry.register(provider);
    expect(registry.getOrThrow('github')).toBe(provider);
  });

  it('list returns all registered providers', () => {
    const registry = new ReviewProviderRegistry();
    const gh = makeFakeProvider('github');
    const gl = makeFakeProvider('gitlab');
    registry.register(gh);
    registry.register(gl);
    expect(registry.list()).toEqual(expect.arrayContaining([gh, gl]));
    expect(registry.list()).toHaveLength(2);
  });

  it('list returns empty array when no providers registered', () => {
    const registry = new ReviewProviderRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('register overwrites existing provider with same name', () => {
    const registry = new ReviewProviderRegistry();
    const v1 = makeFakeProvider('github');
    const v2 = makeFakeProvider('github');
    registry.register(v1);
    registry.register(v2);
    expect(registry.get('github')).toBe(v2);
    expect(registry.list()).toHaveLength(1);
  });
});
