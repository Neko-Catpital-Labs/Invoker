# Recovery Lifecycle Worker Architecture

## Summary

State transitions publish lifecycle events. Recovery behavior is owned by subscriber workers.

The producer of a persisted workflow or task state change is responsible for publishing a lifecycle wakeup after the durable state change is recorded. The producer must not directly auto-fix, recreate, or launch external recovery scripts as part of handling a failed delta. Auto-fix and external recovery are worker responsibilities, and workers must act through the same normal command routes used by operators.

This is a docs-only architecture note. It describes the target contract and does not change runtime behavior.

## Current Overlap

Auto-fix and external recovery both respond to failed deltas today, but they do so as separate direct handlers. That makes failed-delta recovery ownership ambiguous:

1. Auto-fix can be scheduled directly from failure handling.
2. External recovery can be launched directly from failure handling.
3. Both paths can observe the same failed state and compete to decide what recovery means.

The overlap is not only duplication. It hides recovery policy inside producers that should be responsible for state transition and publication, not for choosing a recovery implementation.

## Target Model

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

The target model separates responsibilities:

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

The auto-fix worker owns automatic fix attempts for states that qualify for agent-driven repair. It subscribes to lifecycle wakeups, scans persisted state, and decides whether an auto-fix command should be submitted.

The worker should only act when persisted state shows that:

1. The workflow or task is in a state eligible for auto-fix.
2. No newer generation has superseded the failed state.
3. Auto-fix policy allows another attempt.
4. No incompatible recovery action is already in progress.

When those checks pass, the auto-fix worker submits the normal fix command. It must not be invoked directly by the producer that recorded the failed transition.

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
