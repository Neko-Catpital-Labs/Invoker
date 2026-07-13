/**
 * Owner Endpoint Contract — surface-neutral owner discovery and capability.
 *
 * This module models owner discovery without exposing the host surface
 * that launched the owner (interactive window, standalone daemon, etc.).
 * Client code asks "is an owner available?" and "can it accept mutations?"
 * without knowing how the owner was launched.
 *
 * Host implementations (main.ts standalone path, main.ts interactive path) register
 * handlers on the MessageBus that satisfy this contract. They may retain
 * internal details about their launch mode, but those details do not appear
 * in the types below.
 */

import type { MessageBus } from '@invoker/transport';

import { tryPingHeadlessOwner } from './headless-delegation.js';

// ── Contract types ──────────────────────────────────────────

/** What the client learns from a successful owner discovery ping. */
export interface OwnerEndpointInfo {
  /** Opaque identifier for the running owner process. */
  ownerId: string;
  /**
   * Whether this owner can accept bootstrapped standalone mutations.
   * True when the owner has registered the shared mutation delegation
   * handlers. Both interactive GUI owners and detached standalone owners
   * are single-writer owners and can serve these delegated mutations.
   *
   * The client uses this to decide whether post-bootstrap delegation
   * should target this owner or whether a fresh bootstrap is needed.
   */
  canAcceptStandaloneMutations: boolean;
}

/** Discovery failed — no owner is reachable within the timeout. */
export type OwnerNotReachable = null;

/** Result of an owner discovery attempt. */
export type OwnerDiscoveryResult = OwnerEndpointInfo | OwnerNotReachable;

// ── Discovery implementation ────────────────────────────────

/**
 * Discover a running owner endpoint via the MessageBus.
 *
 * This is the single entry point that client code should use instead of
 * calling `tryPingHeadlessOwner` directly and inspecting the raw `mode`
 * field.
 */
export async function discoverOwner(
  messageBus: MessageBus,
  timeoutMs?: number,
): Promise<OwnerDiscoveryResult> {
  const raw = await tryPingHeadlessOwner(messageBus, timeoutMs);
  if (!raw) return null;
  return {
    ownerId: raw.ownerId ?? '',
    canAcceptStandaloneMutations: raw.mode === 'standalone' || raw.mode === 'gui',
  };
}

// ── Capability predicates ───────────────────────────────────

/** Whether the discovered owner accepts standalone-bootstrapped mutations. */
export function isStandaloneCapable(
  owner: OwnerDiscoveryResult,
): owner is OwnerEndpointInfo & { canAcceptStandaloneMutations: true } {
  return owner !== null && owner.canAcceptStandaloneMutations;
}

/** Whether any owner (of any kind) is reachable. */
export function isOwnerReachable(
  owner: OwnerDiscoveryResult,
): owner is OwnerEndpointInfo {
  return owner !== null;
}
