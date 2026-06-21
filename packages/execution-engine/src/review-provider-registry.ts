/**
 * ReviewProviderRegistry — Registry for pluggable review providers.
 *
 * Maps provider names (e.g. 'github', 'gitlab') to MergeGateProvider instances.
 * Follows the same pattern as AgentRegistry.
 */

import type { MergeGateProvider } from './merge-gate-provider.js';

export class ReviewProviderRegistry {
  private providers = new Map<string, MergeGateProvider>();

  register(provider: MergeGateProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): MergeGateProvider | undefined {
    return this.providers.get(name);
  }

  getOrThrow(name: string): MergeGateProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `No review provider registered with name "${name}". Available: [${[...this.providers.keys()].join(', ')}]`,
      );
    }
    return provider;
  }

  list(): MergeGateProvider[] {
    return [...this.providers.values()];
  }
}
