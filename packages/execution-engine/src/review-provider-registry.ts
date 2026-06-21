/**
 * ReviewProviderRegistry — Registry for pluggable review providers.
 *
 * Maps provider names (e.g. 'github', 'gitlab') to ReviewGateProvider instances.
 * Follows the same pattern as AgentRegistry.
 */

import type { ReviewGateProvider } from './merge-gate-provider.js';

export class ReviewProviderRegistry {
  private providers = new Map<string, ReviewGateProvider>();

  register(provider: ReviewGateProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ReviewGateProvider | undefined {
    return this.providers.get(name);
  }

  getOrThrow(name: string): ReviewGateProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `No review provider registered with name "${name}". Available: [${[...this.providers.keys()].join(', ')}]`,
      );
    }
    return provider;
  }

  list(): ReviewGateProvider[] {
    return [...this.providers.values()];
  }
}
