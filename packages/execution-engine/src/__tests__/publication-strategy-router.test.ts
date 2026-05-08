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

  describe('github_pr strategy end-to-end contract', () => {
    it('resolved provider returns stable {url, identifier} from createReview', async () => {
      const registry = new ReviewProviderRegistry();
      const github: MergeGateProvider = {
        name: 'github',
        createReview: async (opts) => ({
          url: `https://github.com/owner/repo/pull/99`,
          identifier: '99',
        }),
        checkApproval: async () => ({ approved: false, rejected: false, statusText: 'Awaiting review', url: '' }),
      };
      registry.register(github);

      const provider = resolvePublicationProvider('github_pr', registry);
      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/x',
        title: 'Test',
        cwd: '/tmp',
        body: '## Summary',
      });

      expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/99', identifier: '99' });
      expect(typeof result.url).toBe('string');
      expect(typeof result.identifier).toBe('string');
    });

    it('resolved provider returns stable approval status from checkApproval', async () => {
      const registry = new ReviewProviderRegistry();
      const github: MergeGateProvider = {
        name: 'github',
        createReview: async () => ({ url: '', identifier: '99' }),
        checkApproval: async () => ({
          approved: true,
          rejected: false,
          statusText: 'Approved',
          url: 'https://github.com/owner/repo/pull/99',
        }),
      };
      registry.register(github);

      const provider = resolvePublicationProvider('github_pr', registry);
      const status = await provider.checkApproval({ identifier: '99', cwd: '/tmp' });

      expect(status.approved).toBe(true);
      expect(status.rejected).toBe(false);
      expect(status.statusText).toBe('Approved');
      expect(status.url).toBe('https://github.com/owner/repo/pull/99');
    });

    it('wiring pattern matches production: GitHubMergeGateProvider registered as github', () => {
      // This mirrors what main.ts and headless.ts do at startup
      const registry = new ReviewProviderRegistry();
      const github = makeFakeProvider('github');
      registry.register(github);

      // Also provide a fallback (legacy pattern)
      const fallback = makeFakeProvider('github');

      // Strategy resolution should prefer registry over fallback
      const provider = resolvePublicationProvider('github_pr', registry, fallback);
      expect(provider).toBe(github);
      expect(provider).not.toBe(fallback);
    });

    it('undefined strategy defaults to github_pr and resolves registered github provider', () => {
      const registry = new ReviewProviderRegistry();
      const github = makeFakeProvider('github');
      registry.register(github);

      // When workflow has no publicationStrategy set, should still resolve to github
      const provider = resolvePublicationProvider(undefined, registry);
      expect(provider).toBe(github);
    });
  });
});
