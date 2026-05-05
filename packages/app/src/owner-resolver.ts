/**
 * Owner Resolver — centralizes discovery, staleness refresh, and bootstrap.
 *
 * The resolver encapsulates the three-phase owner acquisition policy:
 *   1. Discover a live owner via IPC ping.
 *   2. If stale (unreachable or not standalone-capable), refresh the bus and retry.
 *   3. If no owner is available at all, bootstrap one.
 *
 * The interface is surface-neutral: callers receive an OwnerEndpointInfo and a
 * MessageBus handle, but never branch on GUI/headless mode flags.
 */

import type { MessageBus } from '@invoker/transport';

import {
  discoverOwner,
  isOwnerReachable,
  isStandaloneCapable,
  type OwnerDiscoveryResult,
  type OwnerEndpointInfo,
} from './owner-endpoint.js';

// ── Result types ────────────────────────────────────────────

export type ResolvedOwner = {
  owner: OwnerEndpointInfo;
  bus: MessageBus;
};

export type OwnerResolveResult =
  | { resolved: true; owner: OwnerEndpointInfo; bus: MessageBus }
  | { resolved: false };

// ── Dependency contract ─────────────────────────────────────

export interface OwnerResolverDeps {
  /** Current message bus for IPC communication. */
  messageBus: MessageBus;
  /** Provision a new message bus (reconnect after staleness). */
  refreshMessageBus?: () => Promise<MessageBus>;
  /** Bootstrap a standalone owner process. */
  ensureStandaloneOwner: (bus: MessageBus) => Promise<void>;
}

// ── Configuration ───────────────────────────────────────────

export interface OwnerResolverOptions {
  /** Timeout for owner discovery ping (ms). Default: 3000. */
  discoveryTimeoutMs?: number;
  /** Timeout for post-refresh re-discovery ping (ms). Default: 1000. */
  refreshDiscoveryTimeoutMs?: number;
  /** Timeout waiting for owner readiness after bootstrap (ms). Default: 20000. */
  postBootstrapReadyTimeoutMs?: number;
  /** Maximum bootstrap restart attempts. Default: 3. */
  maxBootstrapAttempts?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_REFRESH_DISCOVERY_TIMEOUT_MS = 1_000;
const DEFAULT_POST_BOOTSTRAP_READY_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BOOTSTRAP_ATTEMPTS = 3;

// ── Resolver interface ──────────────────────────────────────

export interface OwnerResolver {
  /**
   * Attempt to discover an already-running standalone-capable owner.
   * Returns the owner and bus if found, or { resolved: false } if not.
   */
  discover(): Promise<OwnerResolveResult>;

  /**
   * Refresh the bus and re-attempt discovery.
   * Use when the initial discovery returned a stale or unreachable endpoint.
   */
  refreshAndDiscover(): Promise<OwnerResolveResult>;

  /**
   * Full resolve: discover → refresh → bootstrap → discover.
   * Guarantees a standalone-capable owner or throws after exhausting retries.
   *
   * @param requireStandalone If true, only a standalone-capable owner counts
   *   as resolved. If false, any reachable owner satisfies the request.
   */
  resolve(requireStandalone?: boolean): Promise<ResolvedOwner>;

  /**
   * Discover any reachable owner (standalone or not).
   * Useful for read-only queries that can target any owner surface.
   */
  discoverAny(): Promise<OwnerResolveResult>;

  /**
   * Wait for any owner to become reachable within a timeout.
   * Polls with refresh between attempts.
   */
  waitForAny(timeoutMs: number): Promise<OwnerResolveResult>;

  /**
   * Wait for a standalone-capable owner after bootstrap.
   * Polls with refresh between attempts.
   */
  waitForStandalone(timeoutMs: number): Promise<OwnerResolveResult>;
}

// ── Implementation ──────────────────────────────────────────

export function createOwnerResolver(
  deps: OwnerResolverDeps,
  options: OwnerResolverOptions = {},
): OwnerResolver {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const refreshDiscoveryTimeoutMs = options.refreshDiscoveryTimeoutMs ?? DEFAULT_REFRESH_DISCOVERY_TIMEOUT_MS;
  const postBootstrapReadyTimeoutMs = options.postBootstrapReadyTimeoutMs ?? DEFAULT_POST_BOOTSTRAP_READY_TIMEOUT_MS;
  const maxBootstrapAttempts = options.maxBootstrapAttempts ?? DEFAULT_MAX_BOOTSTRAP_ATTEMPTS;

  let currentBus = deps.messageBus;

  async function refreshBus(): Promise<MessageBus> {
    if (deps.refreshMessageBus) {
      currentBus = await deps.refreshMessageBus();
    }
    return currentBus;
  }

  function toResult(owner: OwnerDiscoveryResult, bus: MessageBus): OwnerResolveResult {
    if (owner === null) return { resolved: false };
    return { resolved: true, owner, bus };
  }

  function toStandaloneResult(owner: OwnerDiscoveryResult, bus: MessageBus): OwnerResolveResult {
    if (!isStandaloneCapable(owner)) return { resolved: false };
    return { resolved: true, owner, bus };
  }

  const resolver: OwnerResolver = {
    async discover(): Promise<OwnerResolveResult> {
      const owner = await discoverOwner(currentBus, discoveryTimeoutMs);
      return toStandaloneResult(owner, currentBus);
    },

    async refreshAndDiscover(): Promise<OwnerResolveResult> {
      const bus = await refreshBus();
      const owner = await discoverOwner(bus, refreshDiscoveryTimeoutMs);
      return toStandaloneResult(owner, bus);
    },

    async discoverAny(): Promise<OwnerResolveResult> {
      const owner = await discoverOwner(currentBus, discoveryTimeoutMs);
      return toResult(owner, currentBus);
    },

    async waitForAny(timeoutMs: number): Promise<OwnerResolveResult> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const owner = await discoverOwner(currentBus, 2_000);
        if (isOwnerReachable(owner)) {
          return { resolved: true, owner, bus: currentBus };
        }
        await refreshBus();
        await new Promise((r) => setTimeout(r, 250));
      }
      return { resolved: false };
    },

    async waitForStandalone(timeoutMs: number): Promise<OwnerResolveResult> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const owner = await discoverOwner(currentBus, 1_000);
        if (isStandaloneCapable(owner)) {
          return { resolved: true, owner, bus: currentBus };
        }
        await refreshBus();
        await new Promise((r) => setTimeout(r, 250));
      }
      return { resolved: false };
    },

    async resolve(requireStandalone = true): Promise<ResolvedOwner> {
      // Phase 1: Try immediate discovery
      const immediate = await discoverOwner(currentBus, discoveryTimeoutMs);
      if (requireStandalone ? isStandaloneCapable(immediate) : isOwnerReachable(immediate)) {
        return { owner: immediate!, bus: currentBus };
      }

      // Phase 2: Refresh and retry
      if (deps.refreshMessageBus) {
        currentBus = await deps.refreshMessageBus();
      }

      // Phase 3: Bootstrap with retry loop
      for (let attempt = 0; attempt < maxBootstrapAttempts; attempt += 1) {
        await deps.ensureStandaloneOwner(currentBus);

        if (deps.refreshMessageBus) {
          currentBus = await deps.refreshMessageBus();
        }

        // Wait for the bootstrapped owner to become ready
        const result = await resolver.waitForStandalone(postBootstrapReadyTimeoutMs);
        if (result.resolved) {
          return { owner: result.owner, bus: result.bus };
        }

        // Owner didn't come up — refresh and retry bootstrap
        if (deps.refreshMessageBus) {
          currentBus = await deps.refreshMessageBus();
        }
      }

      throw new Error(
        'Could not resolve a standalone-capable owner after exhausting all bootstrap attempts',
      );
    },
  };

  return resolver;
}
