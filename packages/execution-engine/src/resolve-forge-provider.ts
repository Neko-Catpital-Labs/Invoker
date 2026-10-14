import { parseForgeProject, type ForgeProvider } from '@invoker/contracts';

import type { ReviewProviderRegistry } from './review-provider-registry.js';

export interface ResolveForgeProviderOptions {
  readonly reviewProviderRegistry?: ReviewProviderRegistry;
  readonly mergeGateProvider?: ForgeProvider;
  readonly repoUrl?: string;
}

export function resolveForgeProvider(options: ResolveForgeProviderOptions): ForgeProvider {
  const { reviewProviderRegistry, mergeGateProvider, repoUrl } = options;

  if (reviewProviderRegistry) {
    const trimmed = repoUrl?.trim();
    if (!trimmed) {
      throw new Error(
        'A repo URL is required to select a forge provider (github or gitlab).',
      );
    }
    const project = parseForgeProject(trimmed);
    if (!project) {
      throw new Error(
        `Unable to resolve forge kind from repo URL "${trimmed}". ` +
        'Use a github.com or gitlab.com project URL (or INVOKER_GITLAB_HOST).',
      );
    }
    return reviewProviderRegistry.getOrThrow(project.kind);
  }

  if (mergeGateProvider) return mergeGateProvider;

  throw new Error('merge review publication requires a configured review provider');
}
