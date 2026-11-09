import { describe, expect, it } from 'vitest';

import { createDefaultReviewProviders } from '../create-default-review-providers.js';
import { resolveForgeProvider } from '../resolve-forge-provider.js';

describe('resolveForgeProvider', () => {
  it('selects github for a github.com repo URL', () => {
    const providers = createDefaultReviewProviders();
    const provider = resolveForgeProvider({
      reviewProviderRegistry: providers.reviewProviderRegistry,
      repoUrl: 'https://github.com/acme/widgets',
    });
    expect(provider.name).toBe('github');
  });

  it('selects gitlab for a gitlab.com project URL', () => {
    const providers = createDefaultReviewProviders();
    const provider = resolveForgeProvider({
      reviewProviderRegistry: providers.reviewProviderRegistry,
      repoUrl: 'https://gitlab.com/Group/Sub/Project',
    });
    expect(provider.name).toBe('gitlab');
  });

  it('uses the configured fallback provider for a local file repo URL', () => {
    const providers = createDefaultReviewProviders();
    const provider = resolveForgeProvider({
      reviewProviderRegistry: providers.reviewProviderRegistry,
      mergeGateProvider: providers.mergeGateProvider,
      repoUrl: 'file:///tmp/local-repo',
    });
    expect(provider).toBe(providers.mergeGateProvider);
  });

  it.each([
    'file://remote-host/repo',
    'https://example.com/acme/widgets',
  ])('rejects an unrecognized non-local repo URL: %s', (repoUrl) => {
    const providers = createDefaultReviewProviders();
    expect(() => resolveForgeProvider({
      reviewProviderRegistry: providers.reviewProviderRegistry,
      mergeGateProvider: providers.mergeGateProvider,
      repoUrl,
    })).toThrow(/unable to resolve forge kind/i);
  });

  it('throws when the registry is set and the repo URL is missing', () => {
    const providers = createDefaultReviewProviders();
    expect(() => resolveForgeProvider({
      reviewProviderRegistry: providers.reviewProviderRegistry,
    })).toThrow(/repo URL is required/i);
  });
});
