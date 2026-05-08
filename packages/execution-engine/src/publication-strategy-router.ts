/**
 * Publication strategy router.
 *
 * Maps a workflow's `publicationStrategy` key (e.g. `'github_pr'`,
 * `'mergify_stack'`) to the concrete {@link MergeGateProvider} that
 * handles review creation and approval polling.
 *
 * The router consults two sources in order:
 *   1. A built-in mapping of strategy keys to provider names.
 *   2. The {@link ReviewProviderRegistry} to resolve the provider name.
 *
 * If the strategy is unrecognised or no matching provider is registered
 * the router throws, forcing callers to fail fast rather than silently
 * fall through to a wrong provider.
 */

import type { MergeGateProvider } from './merge-gate-provider.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';

// ── Strategy → provider-name mapping ─────────────────────

/** Known publication strategies and the provider name each maps to. */
const STRATEGY_TO_PROVIDER: Record<string, string> = {
  github_pr: 'github',
  mergify_stack: 'mergify_stack',
};

// ── Public API ───────────────────────────────────────────

export type PublicationStrategyKey = 'github_pr' | 'mergify_stack';

/**
 * Resolve the {@link MergeGateProvider} for the given publication strategy.
 *
 * @param strategy    The workflow-level strategy key (defaults to `'github_pr'`).
 * @param registry    Provider registry to look up the concrete implementation.
 * @param fallback    Optional provider to use when the registry has no match
 *                    (e.g. the legacy `mergeGateProvider` singleton on TaskRunner).
 * @returns           The resolved provider.
 * @throws            When no provider can be resolved for the strategy.
 */
export function resolvePublicationProvider(
  strategy: string | undefined,
  registry: ReviewProviderRegistry | undefined,
  fallback?: MergeGateProvider,
): MergeGateProvider {
  const effectiveStrategy = strategy ?? 'github_pr';
  const providerName = STRATEGY_TO_PROVIDER[effectiveStrategy];

  if (!providerName) {
    throw new Error(
      `Unknown publication strategy "${effectiveStrategy}". ` +
      `Supported strategies: ${Object.keys(STRATEGY_TO_PROVIDER).join(', ')}.`,
    );
  }

  // Try registry first.
  if (registry) {
    const provider = registry.get(providerName);
    if (provider) return provider;
  }

  // Fall back to the legacy singleton when the registry has no match
  // and the strategy maps to the same provider the fallback represents.
  if (fallback && fallback.name === providerName) {
    return fallback;
  }

  // When the fallback is a different provider (or absent) and the strategy
  // is the default `github_pr`, still accept the fallback. This preserves
  // backward compatibility for callers that only set `mergeGateProvider`
  // without populating the registry.
  if (fallback && effectiveStrategy === 'github_pr') {
    return fallback;
  }

  throw new Error(
    `No provider registered for publication strategy "${effectiveStrategy}" ` +
    `(provider name "${providerName}"). ` +
    `Register a provider with name "${providerName}" in the ReviewProviderRegistry.`,
  );
}
