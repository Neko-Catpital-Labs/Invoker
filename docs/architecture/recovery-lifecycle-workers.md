# Recovery Lifecycle Worker Architecture

## Summary

State transitions publish lifecycle events. Recovery behavior is owned by subscriber workers.

The producer of a persisted workflow or task state change is responsible for publishing a lifecycle wakeup after the durable state change is recorded. The producer must not directly auto-fix, recreate, or launch external recovery scripts as part of handling a failed delta. Auto-fix and external recovery are worker responsibilities, and workers must act through the same normal command routes used by operators.

This is a docs-only architecture note. It describes the achieved contract and does not change runtime behavior.

## Resolved Overlap (Single Engine)

Earlier, auto-fix ran from more than one place: a producer could schedule auto-fix directly from failure handling, and a separate worker loop could also act on the same failed state. Two engines could observe the same failure and compete over what recovery meant.

That overlap is now resolved. There is exactly **one** shared auto-fix worker engine, and it lives in `@invoker/execution-engine`. Both entry points drive that same single engine instead of running their own loops:

1. The production door: `invoker-cli worker autofix`.
2. The dev door: `./run.sh --headless worker autofix`.

Two properties keep the single engine truly single:

- **Foreground lifetime.** The worker lives and dies with its process. There is no detached or background recovery service; stopping the process stops the engine.
- **Single-instance lock.** A cross-door lock refuses a second concurrent start. If one door already runs the engine, the other door refuses to start a second loop rather than spawning one.

A **sweep-and-assert guard** test fails the build if auto-fix is triggered from any code path outside the shared worker engine (with an allowlist for the engine itself and the sanctioned operator fix command). This locks the single-engine invariant in against future drift, so a new direct auto-fix call cannot reintroduce a second recovery path.

## Achieved Model

Lifecycle events are ephemeral wakeups, not durable truth. Persisted workflow and task state remains authoritative.

```mermaid
flowchart LR
  PersistedChange[Persisted state change] --> Event[Lifecycle event]
  Event --> Worker[Worker wake]
  Worker --> Scan[Persisted scan]
  Scan --> Decision[Reconcile recovery need]
  Decision --> Command[Normal command submission]
  Command --> PersistedChange
```

The achieved model separates responsibilities:

| Responsibility | Owner | Contract |
| --- | --- | --- |
| Persist state transition | Producer | Write the authoritative workflow or task state first. |
| Publish lifecycle wakeup | Producer | Emit an event after the persisted transition so subscribers can re-check state. |
| Decide recovery action | Worker | Read persisted state and reconcile whether work is still needed. |
| Execute recovery | Worker through command route | Submit normal commands rather than mutating recovery state directly. |

Producers must not directly auto-fix, recreate, or launch external recovery scripts. They publish lifecycle events and leave recovery decisions to subscribers.

## Durable State Authority

The message bus is not the source of truth. Lifecycle events may be missed, duplicated, delayed, or observed by multiple subscribers. Workers must treat events as prompts to inspect durable state.

Required behavior:

1. Persisted workflow and task state determines whether recovery is needed.
2. Lifecycle events only wake subscribers so they can scan persisted state.
3. Workers must be idempotent against repeated wakeups.
4. Workers must tolerate missed events by relying on periodic or startup scans where needed.
5. Recovery commands must re-check current state through existing command handling before making changes.

This preserves the existing persistence model while allowing the recovery system to become event-driven.

## Worker Wakeups

A lifecycle event should carry enough context to make wakeups efficient, such as workflow ID, task ID, transition type, and generation where available. That context is an optimization, not authority.

On wake, a worker should:

1. Load the current persisted workflow and task state.
2. Ignore stale wakeups that no longer match the persisted generation or status.
3. Decide whether its specific recovery responsibility applies.
4. Submit a normal command when recovery is still needed.
5. Record any worker-owned bookkeeping through normal persistence paths.

Workers may subscribe to the same lifecycle event stream. Contention is controlled by persisted state checks and command-route validation, not by assuming one subscriber receives a unique event.

## Auto-Fix Worker

Automatic fix attempts are owned by a **single** shared auto-fix worker engine in `@invoker/execution-engine`. Both doors — `invoker-cli worker autofix` (production) and `./run.sh --headless worker autofix` (dev) — drive that one engine. The engine subscribes to lifecycle wakeups, scans persisted state, and decides whether an auto-fix command should be submitted.

Lifetime and concurrency are constrained so the single engine stays single:

- The worker is **foreground**: it lives and dies with its process, with no detached background service.
- A **single-instance lock** refuses a second concurrent start across both doors, so at most one recovery loop runs process-wide.

The engine should only act when persisted state shows that:

1. The workflow or task is in a state eligible for auto-fix.
2. No newer generation has superseded the failed state.
3. Auto-fix policy allows another attempt.
4. No incompatible recovery action is already in progress.

When those checks pass, the auto-fix worker submits the normal fix command. It must not be invoked directly by the producer that recorded the failed transition. A sweep-and-assert guard test fails the build if any auto-fix is triggered outside this shared worker engine.

## Operator Status

Operators can inspect recovery ownership and recent decisions with:

```bash
./run.sh --headless worker status --output text
./run.sh --headless worker status --output json
```

The status view is audit-backed and read-only. It reports the recovery worker id, owner, last wakeup, last scan, last submitted recovery command, and the latest skip reason. Status reporting must not change recovery eligibility or command submission ordering.

## External Recovery Worker

The external recovery worker owns integration with external recovery automation. It subscribes to lifecycle wakeups, scans persisted state, and decides whether an external recovery command should be submitted or whether an external process should be coordinated through a command route.

The worker should only act when persisted state shows that:

1. The workflow or task is in a state eligible for external recovery.
2. The current generation still matches the observed failure.
3. External recovery policy selects this workflow or task.
4. Auto-fix or another recovery path has not already claimed or resolved the state.

External scripts must not be launched directly by state-transition producers. Any external recovery launch must be initiated by the external recovery worker after it has reconciled persisted state.

## Cleanup Of Direct Handlers

Later implementation slices should remove failed-delta handlers that directly schedule auto-fix or directly launch external recovery scripts. Those handlers should become lifecycle publishers only.

Cleanup should preserve these invariants:

1. State changes are persisted before lifecycle events are published.
2. Lifecycle events are wakeups and may be replayed or missed.
3. Persisted state remains authoritative for all recovery decisions.
4. Recovery workers submit normal commands instead of bypassing command handling.
5. Producers do not directly auto-fix, recreate, or launch external recovery scripts.

## What I Intend To Do

1. Event foundation: add lifecycle-event publication at the relevant persisted state transitions, with producers limited to publishing wakeups after durable state changes.
2. Auto-fix worker: move automatic fix behavior behind a subscriber worker that wakes on lifecycle events, scans persisted state, and submits normal fix commands.
3. External recovery cleanup and regression: move external recovery launch behavior behind its worker, remove direct failed-delta launch paths, and add regression coverage that proves producers publish wakeups without owning recovery.
