# Persisted Execution and Workflow Queue Refactor

## Summary

Refactor Invoker so both task execution and workflow-scoped mutation serialization are DB-backed. SQLite becomes the only source of truth for what is running, queued, claimed, or interrupted. The current in-memory task scheduler and in-memory workflow mutation coordinator stop being correctness-critical. Deliver this in phases, with all tests and reproductions passing after each phase.

## Phase 1: Queue/status truth comes from persistence

- Replace `/api/queue`, CLI queue/status, and related summaries so they derive from persisted task/attempt state rather than the in-memory task scheduler.
- Add a single derived queue view in the orchestrator/data layer that computes:
  - active task attempts
  - ready pending task attempts
  - queue ordering from persisted priority and graph readiness
- Keep the current launcher temporarily, but make stale in-memory slots invisible to users.
- Add a similar persisted status view for workflow mutation state so the app can report whether a workflow is idle, leased, or has pending mutations.

## Phase 2: Persisted task claims and leases

- Extend persisted attempt state to represent execution ownership and concurrency directly.
- Add fields sufficient for task-claim semantics:
  - `status` with explicit claimed/running terminal states
  - `workerId`
  - `claimedAt`
  - `lastHeartbeatAt`
  - `leaseExpiresAt`
- Only persisted claimed/running attempts consume concurrency.
- Change startup recovery to reclaim expired task leases from DB and reschedule from there.
- Demote the in-memory task scheduler to a launch helper only; it cannot be a running-truth authority.

## Phase 3: Replace workflow in-memory queue with DB-backed workflow leases

- Remove the current process-local workflow mutation coordinator as the serialization authority.
- Introduce persisted workflow mutation ownership:
  - one active workflow lease per workflow
  - optional persisted mutation intent row when a mutation must wait behind an active lease
- Recommended schema concepts:
  - workflow lease: `workflowId`, `ownerId`, `leasedAt`, `leaseExpiresAt`, `lastHeartbeatAt`, `activeMutationKind`
  - workflow mutation intent: durable record of the requested operation, payload, priority, status, timestamps, idempotency key
- `runWorkflowMutation(...)` becomes:
  - try to claim the workflow lease atomically
  - if free, persist intent as active and execute
  - if held, persist intent as queued for that workflow
- On owner restart:
  - reclaim expired workflow leases
  - retry queued/interrupted workflow mutations idempotently from persisted intent records

## Phase 4: Normalize all mutation and retry flows onto persisted attempts/intents

- Refactor restart/recreate/fix/conflict-resolution flows so they operate only through persisted attempt transitions and persisted workflow mutation intents.
- Every reset/retry path must:
  - supersede or cancel the prior active attempt in persistence
  - clear its active lease
  - create/select a fresh pending attempt if rerun is intended
- Every workflow-scoped mutation must:
  - be idempotent under retry after process death
  - either complete and mark intent done, or remain resumable/retryable from DB
- Remove any code path that depends on in-memory scheduler cleanup or in-memory workflow queue drain for correctness.

## Interfaces and behavior

- `/api/queue` and `/api/tasks` must agree because both are derived from persisted task/attempt state.
- Workflow mutation state becomes queryable from persistence rather than inferred from the current owner process.
- New persisted entities/fields are required:
  - task attempt lease fields
  - workflow lease fields
  - workflow mutation intent records
- In-memory maps for child process handles may remain for kill/resume UX, but they are not queue or execution truth.

## Test plan

- Regression: task is `pending` in DB but stale in-memory scheduler says running; queue/status must report not running.
- Regression: workflow mutation queued behind another mutation survives owner restart and executes after lease reclaim.
- Lease tests: atomic task claim, workflow lease claim, lease renewal, lease expiry, reclaim after restart.
- Crash tests:
  - owner dies during task startup
  - owner dies during workflow mutation
  - owner dies during fix/recreate path
  In all cases, restart must reconstruct from DB with no leaked running slots or lost queued workflow mutations.
- Repro tests for the current stale-queue bug and for workflow mutation loss on restart.
- Re-run existing orphan-reconciliation, API server, restart, fix-with-agent, recreate, and queue/status suites after each phase.

## Assumptions

- Workflow mutations should be durable and retried idempotently after owner restart.
- A DB-backed workflow lease is preferred over preserving the current in-memory per-workflow queue model.
- If a workflow mutation must wait, it should be persisted as an intent record rather than held only in memory.
- SQLite alone must be sufficient to answer: what is running, what is queued, what is leased, and what should be retried after restart.
