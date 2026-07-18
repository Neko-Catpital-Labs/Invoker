/**
 * Launch-handoff invariant assertion.
 *
 * Companion to the launch-handoff re-architecture (see
 * `docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md`).
 *
 * The invariant: every `task.launch_claimed` event recorded by the
 * orchestrator must be followed within a bounded window by a terminal
 * launch event for the same task. Terminal launch events are the
 * concrete outcomes that resolve the durable launch claim:
 *
 *   - `task.executor.selected`            — executor picked and started
 *   - `task.executor.deferred`            — executor selection deferred (capacity/lease)
 *   - `task.executor.startup-retry`       — transient startup error, retry pending
 *   - `task.running`                       — launch fully transitioned to executing
 *   - `task.failed`                        — launch resulted in a concrete failure
 *   - `task.prepared_for_new_attempt`      — orchestrator reset the claim to retry
 *
 * Any `task.launch_claimed` that does not reach one of these within
 * `maxGapMs` is treated as an orphaned launch claim — exactly the
 * symptom catalogued in the 2026-05-22 incident.
 */

import type { PersistenceAdapter, TaskEvent } from '@invoker/data-store';
import { DISPATCH_LEASE_MS, DISPATCH_MAX_ATTEMPTS } from '@invoker/contracts';

export const LAUNCH_CLAIM_EVENT_TYPE = 'task.launch_claimed';

export const TERMINAL_LAUNCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.executor.selected',
  'task.executor.deferred',
  'task.executor.startup-retry',
  'task.running',
  'task.failed',
  'task.prepared_for_new_attempt',
]);

/**
 * Default upper bound on the gap between `task.launch_claimed` and the next
 * terminal launch event. It follows the fixed dispatch crash-recovery window
 * with a small scheduler buffer. Tests that drive a deterministic in-memory
 * scenario should pass a tighter bound.
 */
export const DEFAULT_LAUNCH_INVARIANT_MAX_GAP_MS =
  DISPATCH_LEASE_MS * DISPATCH_MAX_ATTEMPTS + 30_000;

export type LaunchInvariantPersistence = Pick<
  PersistenceAdapter,
  'getAllTaskIds' | 'getEvents'
>;

export interface LaunchInvariantOptions {
  /** Maximum allowed gap (ms) between claim and terminal launch event. */
  maxGapMs?: number;
  /** Restrict the scan to these task ids; default scans every task. */
  taskIds?: readonly string[];
  /**
   * Optional `now` override for deterministic tests where the latest
   * event has not yet been followed by anything but enough wall-clock
   * time has passed that we want to treat it as a violation regardless.
   * Defaults to `Date.now()`.
   */
  nowMs?: number;
}

export type LaunchInvariantViolationReason =
  | 'no_terminal_event'
  | 'gap_exceeded';

export interface LaunchInvariantViolation {
  taskId: string;
  claimEventId: number;
  claimAt: string;
  /** Undefined when no later terminal event exists at all. */
  nextEventType?: string;
  nextEventAt?: string;
  /** Null when there is no later terminal event to compare against. */
  gapMs: number | null;
  reason: LaunchInvariantViolationReason;
}

export interface LaunchInvariantResult {
  taskCount: number;
  claimCount: number;
  violations: readonly LaunchInvariantViolation[];
}

export class LaunchInvariantViolationError extends Error {
  readonly violations: readonly LaunchInvariantViolation[];
  readonly summary: { taskCount: number; claimCount: number };

  constructor(
    violations: readonly LaunchInvariantViolation[],
    summary: { taskCount: number; claimCount: number },
  ) {
    super(formatViolationMessage(violations, summary));
    this.name = 'LaunchInvariantViolationError';
    this.violations = violations;
    this.summary = summary;
  }
}

/**
 * Walk the events table for the given (or all) tasks and assert the
 * launch-claim invariant. Throws `LaunchInvariantViolationError` when
 * any violation is found.
 */
export function assertLaunchInvariant(
  persistence: LaunchInvariantPersistence,
  options: LaunchInvariantOptions = {},
): LaunchInvariantResult {
  const maxGapMs = options.maxGapMs ?? DEFAULT_LAUNCH_INVARIANT_MAX_GAP_MS;
  const taskIds = options.taskIds ?? persistence.getAllTaskIds();
  const nowMs = options.nowMs ?? Date.now();

  const violations: LaunchInvariantViolation[] = [];
  let claimCount = 0;

  for (const taskId of taskIds) {
    const events = persistence.getEvents(taskId);
    for (let i = 0; i < events.length; i++) {
      const claim = events[i];
      if (claim.eventType !== LAUNCH_CLAIM_EVENT_TYPE) continue;
      claimCount += 1;

      const next = findResolvingEvent(events, i + 1);
      if (!next) {
        const claimMs = Date.parse(claim.createdAt);
        const ageMs = Number.isFinite(claimMs)
          ? Math.max(0, nowMs - claimMs)
          : Number.POSITIVE_INFINITY;
        if (ageMs > maxGapMs) {
          violations.push({
            taskId,
            claimEventId: claim.id,
            claimAt: claim.createdAt,
            gapMs: null,
            reason: 'no_terminal_event',
          });
        }
        continue;
      }

      const gapMs = parseGapMs(claim.createdAt, next.createdAt);
      if (gapMs > maxGapMs) {
        violations.push({
          taskId,
          claimEventId: claim.id,
          claimAt: claim.createdAt,
          nextEventType: next.eventType,
          nextEventAt: next.createdAt,
          gapMs,
          reason: 'gap_exceeded',
        });
      }
    }
  }

  const summary = { taskCount: taskIds.length, claimCount };
  if (violations.length > 0) {
    throw new LaunchInvariantViolationError(violations, summary);
  }
  return { ...summary, violations };
}

/**
 * Walk `events` starting at `startIndex` and return the first terminal
 * launch event, OR `undefined` when another `task.launch_claimed`
 * appears first (which itself is an orphan: a fresh claim recorded
 * without the previous one being resolved).
 */
function findResolvingEvent(
  events: readonly TaskEvent[],
  startIndex: number,
): TaskEvent | undefined {
  for (let i = startIndex; i < events.length; i++) {
    const event = events[i];
    if (event.eventType === LAUNCH_CLAIM_EVENT_TYPE) {
      return undefined;
    }
    if (TERMINAL_LAUNCH_EVENT_TYPES.has(event.eventType)) {
      return event;
    }
  }
  return undefined;
}

function parseGapMs(claimAt: string, nextAt: string): number {
  const claimMs = Date.parse(claimAt);
  const nextMs = Date.parse(nextAt);
  if (!Number.isFinite(claimMs) || !Number.isFinite(nextMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, nextMs - claimMs);
}

function formatViolationMessage(
  violations: readonly LaunchInvariantViolation[],
  summary: { taskCount: number; claimCount: number },
): string {
  const lines = violations.slice(0, 5).map((v) => {
    const base = `  taskId=${v.taskId} claimEventId=${v.claimEventId} reason=${v.reason}`;
    const nextPart = v.nextEventType ? ` next=${v.nextEventType}` : '';
    const gapPart = v.gapMs != null ? ` gapMs=${v.gapMs}` : '';
    return `${base}${nextPart}${gapPart}`;
  });
  const more =
    violations.length > 5 ? `\n  ... and ${violations.length - 5} more` : '';
  return (
    `Launch invariant violated: ${violations.length} of ${summary.claimCount} ` +
    `task.launch_claimed events across ${summary.taskCount} tasks did not reach ` +
    `a terminal launch event within the allowed window.\n` +
    lines.join('\n') +
    more
  );
}
