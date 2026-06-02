# Recovery Lifecycle Workers

## Summary

Failed-task recovery should be owned by subscriber workers, not by the
producer that records a state transition. A producer's responsibility is to
persist the authoritative workflow/task state change and publish a lifecycle
wakeup. Recovery workers consume that wakeup, scan persisted state, and submit
ordinary commands through the same routes as users and automation.

This keeps auto-fix and external recovery from competing as direct failed-delta
handlers while preserving the existing persistence model: lifecycle events are
wakeups, and persisted workflow state remains authoritative.

## Current Overlap

The current recovery shape has overlapping ownership:

1. The task failure path can decide that auto-fix should run immediately.
2. External recovery can observe a similar failed-delta signal and launch a
   script directly.
3. Recreate and retry paths can also be reached from recovery logic instead of
   from normal command routing.

Those paths all react to failure, but they do not share one recovery owner. The
result is hidden coupling: a producer that records a failed state can also
become the component that chooses an auto-fix, recreate, or external recovery
side effect.

## Target Model

State-transition producers publish lifecycle events after durable state changes.
Subscriber workers own recovery behavior.

```mermaid
flowchart LR
  PersistedChange[Persisted state change]
  Event[Lifecycle event wakeup]
  Worker[Worker wake]
  Scan[Persisted state scan]
  Command[Normal command submission]

  PersistedChange --> Event --> Worker --> Scan --> Command
  Scan --> PersistedChange
```

The event is intentionally not the source of truth. It is only a prompt to look
again. A worker must reconcile against persisted workflow and task state before
deciding whether any recovery command is still valid.

## Contract

1. Producers must persist state first, then publish lifecycle events.
2. Producers must not directly auto-fix, recreate, or launch external recovery
   scripts.
3. Lifecycle events are ephemeral wakeups, not durable facts.
4. Persisted workflow state remains authoritative for recovery decisions.
5. Workers may submit recovery only through normal command routes, such as the
   same action/delegation paths used by explicit user commands.
6. Workers must be idempotent: duplicate, delayed, or missed wakeups must not
   create duplicate recovery work.

## Durable State Authority

The message bus can lose history across process restarts and should remain
ephemeral. It is acceptable for a lifecycle event to be dropped because the
worker can scan persisted state on startup, on timers, and after later wakeups.

Recovery decisions must be based on durable fields such as task status,
workflow generation, selected attempt, auto-fix attempt counts, pending recovery
metadata, and cancellation or supersession state. If a lifecycle event says a
task failed but the database now says the task was recreated, completed, or
superseded, the worker must trust the database and skip stale work.

## Worker Wakeups

A lifecycle event should contain enough identity to make a worker scan cheap,
such as workflow id, task id, transition type, generation, and attempt id when
available. It should not contain enough policy to decide recovery by itself.

Workers should wake from:

1. Lifecycle events published by state transitions.
2. Startup reconciliation scans.
3. Bounded periodic scans for missed events.

The wakeup path can narrow the scan, but the scan still decides.

## Auto-Fix Worker

The auto-fix worker owns policy for automated fix attempts. On wakeup, it scans
persisted failed or review-gate-failed tasks, checks the configured retry
budget, validates lineage, and submits a normal fix command when eligible.

The worker should not call low-level producer internals as a shortcut. It should
act like an operator using the supported command/action surface. This keeps
auto-fix behavior compatible with owner delegation, generation checks, audit
logging, and future surfaces.

## External Recovery Worker

The external recovery worker owns policy for invoking configured external
recovery behavior. On wakeup, it scans persisted state for recoverable workflows
or tasks, applies its external-recovery eligibility rules, and submits ordinary
commands or queued recovery intents through the supported command/action
surface.

External scripts must not be launched directly from the producer that records a
failed transition. If an external script is still needed, the worker owns that
launch decision after reconciling durable state.

## Cleanup Of Direct Handlers

Later implementation work should remove direct failed-delta handlers that run
auto-fix, recreate, or external scripts from producer paths. Producers should
retain only state persistence, lifecycle publication, and local invariants that
are required to make the state transition valid.

Cleanup should preserve existing command behavior by moving recovery decisions
behind workers rather than deleting the supported actions themselves.

## What I Intend To Do

1. Event foundation: add lifecycle-event publication around persisted state
   transitions, with tests that prove events are wakeups and persisted state is
   still authoritative.
2. Auto-fix worker: move auto-fix recovery ownership into a subscriber worker
   that reconciles persisted state and submits normal fix commands.
3. External recovery cleanup and regression: remove direct external recovery
   launches from failed-delta producer paths and add regression coverage for
   missed, duplicate, stale, and competing wakeups.

## Rejected Alternatives

Keeping direct auto-fix scheduling and direct external script launch as separate
paths leaves multiple hidden recovery owners. Each path can be locally
reasonable while still racing the others.

Making lifecycle events the sole source of truth is also rejected. The current
message bus is ephemeral, and persisted workflow state must remain the durable
authority for recovery decisions.
