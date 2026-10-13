import { GitHubMergeGateProvider } from './github-merge-gate-provider.js';
import { GitLabMergeGateProvider } from './gitlab-merge-gate-provider.js';
import type { ForgeProvider } from './merge-gate-provider.js';
import { ReviewProviderRegistry } from './review-provider-registry.js';

export interface DefaultReviewProviders {
  readonly mergeGateProvider: ForgeProvider;
  readonly reviewProviderRegistry: ReviewProviderRegistry;
}

export function createDefaultReviewProviders(): DefaultReviewProviders {
  const github = new GitHubMergeGateProvider();
  const gitlab = new GitLabMergeGateProvider();
  const reviewProviderRegistry = new ReviewProviderRegistry();
  reviewProviderRegistry.register(github);
  reviewProviderRegistry.register(gitlab);
  return {
    mergeGateProvider: github,
    reviewProviderRegistry,
  };
}
