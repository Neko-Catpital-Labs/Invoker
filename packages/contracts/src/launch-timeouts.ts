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
