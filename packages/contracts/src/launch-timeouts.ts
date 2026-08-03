/**
 * Single source of truth for launch-handoff timeout constants.
 *
 * `ATTEMPT_LEASE_MS` was previously duplicated in `@invoker/workflow-core`
 * and `@invoker/execution-engine`; both packages import it from here.
 *
 * `DISPATCH_LEASE_MS` and `DISPATCH_MAX_ATTEMPTS` describe the durable
 * launch-outbox lease lifecycle introduced in the Phase A
 * launch-handoff re-architecture (see
 * `docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md`).
 */

export const ATTEMPT_LEASE_MS = 20 * 60 * 1000;

export const DISPATCH_LEASE_MS = 12 * 60 * 1000;
export const LAUNCH_STUCK_ABANDON_MS = DISPATCH_LEASE_MS;

export const DISPATCH_MAX_ATTEMPTS = 3;

/**
 * Hard cap on how many times `abandonStuckLeases` may prepare a fresh
 * attempt for the SAME task before giving up instead of retrying again.
 *
 * `DISPATCH_MAX_ATTEMPTS` does not bound this loop: `prepareTaskForNewAttempt`
 * creates a brand-new `task_launch_dispatch` row with `attempts_count` back
 * at 0, so the per-row attempt budget never accumulates across cycles. If a
 * task's real work legitimately runs longer than `LAUNCH_STUCK_ABANDON_MS`
 * (e.g. waiting on a slow CI run), the age-based clause alone keeps firing
 * forever with no other stopper (see incident 2026-08-02: one task retried
 * 78 times in 24h on a fixed ~12-minute cadence because of this).
 */
export const MAX_STUCK_LEASE_RETRIES = 5;
