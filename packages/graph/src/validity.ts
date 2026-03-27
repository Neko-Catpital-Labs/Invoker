/**
 * Pure validity functions for the attempt-based execution model.
 *
 * All functions are stateless — they take lookup functions and compute
 * derived state. Nothing is stored; validity is always recomputed.
 */

import type { TaskState, Attempt, TaskStatus } from './types.js';

type NodeLookup = (id: string) => TaskState | undefined;
type AttemptLookup = (id: string) => Attempt | undefined;

/**
 * Is this node's selected attempt based on outdated upstream?
 * A node is stale when its selected attempt consumed upstream outputs
 * that are no longer the currently selected attempts of those upstream nodes.
 */
export function isStale(
  node: TaskState,
  getNode: NodeLookup,
  getAttempt: AttemptLookup,
): boolean {
  const attemptId = node.execution.selectedAttemptId;
  if (!attemptId) return false;
  const attempt = getAttempt(attemptId);
  if (!attempt || attempt.status !== 'completed') return false;

  // Old attempts created before lineage wiring have empty upstreamAttemptIds.
  // Without this guard, they'd be treated as stale for any dep with a
  // selectedAttemptId (empty array never includes anything). Treat empty
  // lineage as "unknown — assume not stale" for backward compatibility.
  if (attempt.upstreamAttemptIds.length === 0 && node.dependencies.length > 0) {
    return false;
  }

  return node.dependencies.some((depId) => {
    const dep = getNode(depId);
    if (!dep?.execution.selectedAttemptId) return false;
    return !attempt.upstreamAttemptIds.includes(dep.execution.selectedAttemptId);
  });
}

/**
 * Is this node blocked by a failed upstream?
 */
export function isBlocked(
  node: TaskState,
  getNode: NodeLookup,
  getAttempt: AttemptLookup,
): boolean {
  return node.dependencies.some((depId) => {
    const dep = getNode(depId);
    if (!dep?.execution.selectedAttemptId) return false;
    const depAttempt = getAttempt(dep.execution.selectedAttemptId);
    return depAttempt?.status === 'failed';
  });
}

/**
 * Is this node ready for a new attempt to be created and scheduled?
 * All upstream must have a completed, non-stale selected attempt.
 */
export function isReady(
  node: TaskState,
  getNode: NodeLookup,
  getAttempt: AttemptLookup,
): boolean {
  if (node.dependencies.length === 0) return true;

  return node.dependencies.every((depId) => {
    const dep = getNode(depId);
    if (!dep?.execution.selectedAttemptId) return false;
    const depAttempt = getAttempt(dep.execution.selectedAttemptId);
    return depAttempt?.status === 'completed' && !isStale(dep, getNode, getAttempt);
  });
}

/**
 * Derive the effective TaskStatus for a node from its attempt state.
 * Used for backward compatibility with UI and existing code that reads task.status.
 */
export function deriveNodeStatus(
  node: TaskState,
  getNode: NodeLookup,
  getAttempt: AttemptLookup,
): TaskStatus {
  const attemptId = node.execution.selectedAttemptId;

  // No attempt yet — use stored status (pending, or whatever it is)
  if (!attemptId) return node.status;

  const attempt = getAttempt(attemptId);
  if (!attempt) return node.status;

  // Check derived states first
  if (attempt.status === 'completed' && isStale(node, getNode, getAttempt)) {
    return 'stale';
  }
  if (isBlocked(node, getNode, getAttempt)) {
    return 'blocked';
  }

  // Map attempt status to TaskStatus
  switch (attempt.status) {
    case 'pending': return 'pending';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'needs_input': return 'needs_input';
    case 'superseded': return 'stale';
    default: return node.status;
  }
}
