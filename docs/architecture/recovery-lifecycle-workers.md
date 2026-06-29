# Recovery Lifecycle Worker Architecture

## Summary

State transitions publish lifecycle events. Recovery behavior is owned by subscriber workers.

The producer of a persisted workflow or task state change is responsible for publishing a lifecycle wakeup after the durable state change is recorded. The producer must not directly auto-fix, recreate, or launch external recovery scripts as part of handling a failed delta. Auto-fix and external recovery are worker responsibilities, and workers must act through the same normal command routes used by operators.

This is a docs-only architecture note. It describes the achieved contract and does not change runtime behavior.

## Registry-Based Workers

Recovery workers are declared through a worker registry in `@invoker/execution-engine`. The registry is the single declaration surface for runnable worker kinds: each worker has a stable `kind`, an operator-facing note, and a factory that builds its runtime from injected dependencies.

The built-in worker is `autofix`. Both entry points resolve that same registry kind instead of owning separate loops:

1. The production door: `invoker-cli worker autofix`.
2. The dev door: `./run.sh --headless worker autofix`.

External workers are operator-declared in config and registered beside built-ins by kind. A configured external worker cannot reuse an existing kind; duplicate kinds fail during registration.

Two properties keep each worker kind truly single:

- **Foreground lifetime.** A worker lives and dies with its process. There is no detached recovery service owned by Invoker.
- **Per-kind single-instance lock.** The headless worker door acquires the lock for the selected worker kind. A second concurrent start of the same kind refuses to run, while different kinds use different lock files.

A generalized sweep-and-assert guard fails the build if auto-fix is triggered from any code path outside the shared worker engine or the sanctioned operator fix command. This locks the registry boundary in place: producers publish lifecycle wakeups, and workers own recovery decisions.

## Achieved Model

Lifecycle events are ephemeral wakeups, not durable truth. Persisted workflow and task state remains authoritative.

```mermaid
flowchart LR
  PersistedChange[Persisted state change] --> Event[Lifecycle event]
  Event --> Registry[Worker registry]
  Registry --> Worker[Worker wake]
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

## Built-In Auto-Fix Worker

Automatic fix attempts are owned by the built-in `autofix` worker registered in `@invoker/execution-engine`. Both doors — `invoker-cli worker autofix` (production) and `./run.sh --headless worker autofix` (dev) — resolve the same registry definition. The worker subscribes to lifecycle wakeups, scans persisted state, and decides whether an auto-fix command should be submitted.

Lifetime and concurrency are constrained per kind:

- The worker is **foreground**: it lives and dies with its process, with no detached background service.
- The **single-instance lock** is keyed by worker kind, so at most one `autofix` loop runs at a time.

The built-in worker should only act when persisted state shows that:

1. The workflow or task is in a state eligible for auto-fix.
2. No newer generation has superseded the failed state.
3. Auto-fix policy allows another attempt.
4. No incompatible recovery action is already in progress.

When those checks pass, the auto-fix worker submits the normal fix command. It must not be invoked directly by the producer that recorded the failed transition. The generalized guard fails the build if any auto-fix trigger appears outside the shared worker engine or the operator command route.

## Operator Status

Operators can inspect recovery ownership and recent decisions with:

```bash
./run.sh --headless worker status --output text
./run.sh --headless worker status --output json
```

The status view is audit-backed and read-only. It reports the recovery worker id, owner, last wakeup, last scan, last submitted recovery command, and the latest skip reason. Status reporting must not change recovery eligibility or command submission ordering.

## External Workers

External workers extend the same registry model. Operators declare `externalWorkers` in config. Each entry supplies a stable registry `kind` and a launch command:

```json
{
  "externalWorkers": [
    {
      "kind": "preview",
      "launch": {
        "executable": "/usr/local/bin/invoker-preview-worker",
        "args": ["--watch"],
        "cwd": "/path/to/workspace"
      }
    }
  ]
}
```

The external worker loader registers each configured kind with the worker registry. Starting `./run.sh --headless worker <kind>` or the equivalent CLI worker door then acquires that kind's lock, starts the configured process, and supervises its lifetime.

The process boundary is explicit:

1. Invoker starts the configured executable with optional args and cwd.
2. The external process owns its recovery logic.
3. Invoker owns lifecycle supervision: inherited stdio, normal exit observation, `SIGTERM` on stop, and `SIGKILL` after the shutdown grace period.
4. The external process must still act through normal command routes when it changes Invoker state.

External scripts must not be launched directly by state-transition producers. Producers publish lifecycle wakeups; configured external workers decide whether to react after inspecting persisted state.

## Boundary Invariants

The registry and guard preserve these invariants:

1. State changes are persisted before lifecycle events are published.
2. Lifecycle events are wakeups and may be replayed or missed.
3. Persisted state remains authoritative for all recovery decisions.
4. Recovery workers submit normal commands instead of bypassing command handling.
5. Producers do not directly auto-fix, recreate, or launch external recovery scripts.
6. Worker kinds are registered once and locked independently.
