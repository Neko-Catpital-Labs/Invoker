import { describe, it, expect } from 'vitest';
import { resolvePublicationProvider } from '../publication-strategy-router.js';
import { ReviewProviderRegistry } from '../review-provider-registry.js';
import type { MergeGateProvider } from '../merge-gate-provider.js';

function makeFakeProvider(name: string): MergeGateProvider {
  return {
    name,
    createReview: async () => ({ url: `https://example.com/${name}/1`, identifier: `${name}#1` }),
    checkApproval: async () => ({ approved: false, rejected: false, statusText: 'pending', url: '' }),
  };
}

describe('resolvePublicationProvider', () => {
  describe('github_pr strategy', () => {
    it('resolves from registry when github provider is registered', () => {
      const registry = new ReviewProviderRegistry();
      const github = makeFakeProvider('github');
      registry.register(github);

      const result = resolvePublicationProvider('github_pr', registry);
      expect(result).toBe(github);
    });

    it('resolves from fallback when registry has no github provider', () => {
      const registry = new ReviewProviderRegistry();
      const fallback = makeFakeProvider('github');

      const result = resolvePublicationProvider('github_pr', registry, fallback);
      expect(result).toBe(fallback);
    });

    it('resolves from fallback even with a different provider name for github_pr', () => {
      const registry = new ReviewProviderRegistry();
      const fallback = makeFakeProvider('custom-gh');

      const result = resolvePublicationProvider('github_pr', registry, fallback);
      expect(result).toBe(fallback);
    });

    it('defaults to github_pr when strategy is undefined', () => {
      const registry = new ReviewProviderRegistry();
      const github = makeFakeProvider('github');
      registry.register(github);

      const result = resolvePublicationProvider(undefined, registry);
      expect(result).toBe(github);
    });

    it('defaults to github_pr with fallback when strategy is undefined', () => {
      const fallback = makeFakeProvider('github');

      const result = resolvePublicationProvider(undefined, undefined, fallback);
      expect(result).toBe(fallback);
    });
  });

  describe('mergify_stack strategy', () => {
    it('resolves from registry when mergify_stack provider is registered', () => {
      const registry = new ReviewProviderRegistry();
      const mergify = makeFakeProvider('mergify_stack');
      registry.register(mergify);

      const result = resolvePublicationProvider('mergify_stack', registry);
      expect(result).toBe(mergify);
    });

    it('throws when mergify_stack provider is not registered', () => {
      const registry = new ReviewProviderRegistry();

      expect(() => resolvePublicationProvider('mergify_stack', registry)).toThrow(
        /No provider registered for publication strategy "mergify_stack"/,
      );
    });

    it('throws when registry is undefined and fallback is a different provider', () => {
      const fallback = makeFakeProvider('github');

      expect(() => resolvePublicationProvider('mergify_stack', undefined, fallback)).toThrow(
        /No provider registered for publication strategy "mergify_stack"/,
      );
    });

    it('resolves from fallback when fallback name matches mergify_stack', () => {
      const fallback = makeFakeProvider('mergify_stack');

      const result = resolvePublicationProvider('mergify_stack', undefined, fallback);
      expect(result).toBe(fallback);
    });
  });

  describe('unknown strategy', () => {
    it('throws for unrecognised strategy key', () => {
      const registry = new ReviewProviderRegistry();

      expect(() => resolvePublicationProvider('unknown_strategy', registry)).toThrow(
        /Unknown publication strategy "unknown_strategy"/,
      );
    });

    it('error message lists supported strategies', () => {
      const registry = new ReviewProviderRegistry();

      expect(() => resolvePublicationProvider('bad', registry)).toThrow(
        /github_pr, mergify_stack/,
      );
    });
  });

  describe('registry precedence over fallback', () => {
    it('prefers registry provider over fallback', () => {
      const registry = new ReviewProviderRegistry();
      const registryProvider = makeFakeProvider('github');
      const fallback = makeFakeProvider('github');
      registry.register(registryProvider);

      const result = resolvePublicationProvider('github_pr', registry, fallback);
      expect(result).toBe(registryProvider);
      expect(result).not.toBe(fallback);
    });
  });

  describe('no registry and no fallback', () => {
    it('throws when both registry and fallback are undefined', () => {
      expect(() => resolvePublicationProvider('github_pr', undefined)).toThrow(
        /No provider registered/,
      );
    });
  });
});
