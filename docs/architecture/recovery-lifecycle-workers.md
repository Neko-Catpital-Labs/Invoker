# Recovery Lifecycle Worker Architecture

## Summary

State transitions publish lifecycle events. Recovery behavior is owned by subscriber workers.

The producer of a persisted workflow or task state change is responsible for publishing a lifecycle wakeup after the durable state change is recorded. The producer must not directly auto-fix, recreate, or launch external recovery scripts as part of handling a failed delta. Auto-fix and external recovery are worker responsibilities, and workers must act through the same normal command routes used by operators.

This note describes the runtime contract.

Worker-status and other main-process poll paths must stay bounded — see
[Main-Process Read Hot Paths](./main-process-read-hot-paths.md).

## Resolved Overlap (Single Engine)

Earlier, auto-fix ran from more than one place: a producer could schedule auto-fix directly from failure handling, and a separate worker loop could also act on the same failed state. Two engines could observe the same failure and compete over what recovery meant.

That overlap is now resolved. There is exactly **one** shared auto-fix worker engine, and it lives in `@invoker/execution-engine`.

These properties define when the single engine runs and keep it truly single:

- **Scan on start.** Starting the worker (the Workers-tab off→on toggle) runs a full scan immediately (`tickOnStart`), so every task that is already failed gets a fix-with-agent intent submitted the moment the worker comes up, not one poll interval later.
- **Owner auto-start.** Owner processes start the auto-fix worker automatically when `autoFixRetries > 0`, so normal task failures do not need an external bash loop.
- **Manual one-shot scan.** `./run.sh --headless worker autofix` drives the same engine for an explicit operator scan.

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

Automatic fix attempts are owned by a **single** shared auto-fix worker engine in `@invoker/execution-engine`. Owner processes auto-start that worker when `autoFixRetries > 0`. The engine subscribes to lifecycle wakeups, scans persisted state, keys consumed attempts in worker runtime memory by task lineage, and decides whether an auto-fix command should be submitted. `./run.sh --headless worker autofix` is only a manual one-shot scan through the same engine.

Lifetime and concurrency are constrained so the single engine stays single:

- The worker is **process-owned**: it lives and dies with the owner process that started it.
- A **single-instance lock** refuses a second concurrent explicit worker start, so manual scans cannot race another explicit worker door.

The engine should only act when persisted state shows that:

1. The workflow or task is in a state eligible for auto-fix.
2. No newer generation has superseded the failed state.
3. `autoFixRetries` leaves in-memory retry budget for the task lineage; `0` disables auto-fix and a finite value such as `3` permits at most three submitted attempts until the worker restarts or the task lineage changes.
4. No incompatible recovery action is already in progress.

When those checks pass, the auto-fix worker submits the normal fix command. It must not be invoked directly by the producer that recorded the failed transition. A sweep-and-assert guard test fails the build if any auto-fix is triggered outside this shared worker engine.

## Requeue Worker (liveness stalls)

Not every failure is a defect the AI should fix. The executing-stall watchdog
force-fails a task whose executor stopped heartbeating with `Execution stalled:
... (attempt lease expired)`. That is a liveness/infrastructure timeout — the
task's work was never proven broken — so handing it to the auto-fix worker just
re-runs the same step, re-stalls, and loops.

Such failures are tagged with a structured `execution.failureClass` of
`liveness_stall` when the stall guard records them. Two rules follow:

- **Auto-fix skips liveness failures.** Both `orchestrator.shouldAutoFix` and the
  auto-fix worker's eligibility check return false for a `liveness_stall`, the
  same way they already skip user-cancelled failures.
- **The requeue worker owns them.** A dedicated subscriber worker wakes on
  lifecycle events, scans persisted state for `failed` + `liveness_stall` tasks,
  and submits the normal `retry-task` command (a requeue — re-run the same work,
  not an AI fix).

The requeue worker is bounded, so it cannot become a different infinite loop:

1. A runtime-local ledger keyed by task **lineage** (`taskId` + `generation`,
   which `retryTask` preserves) caps requeues at `stallRequeueRetries`
   (default 3).
2. A backoff of `stallRequeueBackoffMs` (default 2 minutes) spaces requeues so a
   task is not instantly re-run into the same stall while the machine is still
   overloaded.
3. Once the budget is exhausted the worker submits an escalation command that
   parks the task in `needs_input` with an operator-facing reason, exactly once.

`failureClass` is cleared on every retry/recreate reset, so a requeued run that
later fails for a real reason is classified fresh and routed to auto-fix
normally. As with auto-fix, a sweep-and-assert guard fails the build if the
requeue channel is referenced outside the requeue worker engine and its
dispatcher registration.

Complementary hardening: the merge-gate publish paths (`executeMergeNode` and
`publishAfterFix`) pump the attempt heartbeat/lease while the make-pr publisher
runs, so a slow-but-alive publish is not misclassified as a stall in the first
place.

## Operator Status

Operators can inspect recovery ownership and recent decisions with:

```bash
./run.sh --headless worker status --output text
./run.sh --headless worker status --output json
```

The status view is audit-backed and read-only. It reports the recovery worker id, owner, last wakeup, last scan, last submitted recovery command, and the latest skip reason. Status reporting must not change recovery eligibility or command submission ordering.

## Worker Decision Ledger

Every worker that owns act/skip decisions records them into the durable
`worker_actions` table through the shared `recordWorkerDecisionRow` helper in
`@invoker/execution-engine`. This gives operators one queryable, cross-worker
history of what each worker decided — which tasks the auto-fix worker submitted
for fixing, and which it deliberately skipped and why — instead of
reconstructing it from scattered per-task debug events.

Recording policy:

- **Act** decisions (submit / complete / fail) are always recorded.
- **Meaningful skips** (retry budget exhausted or disabled, not eligible, run
  failure) are recorded with `status: 'skipped'` and a `reason`.
- **Routine scan noise** (stale snapshots, dedupe hits, lock contention,
  vanished tasks) is logged as a per-task debug event only and never creates a
  durable row. `isMeaningfulSkipReason` classifies the reason.

Rows are latest-state-per-lineage: repeated decisions on the same task lineage
(`autofix:<taskId>:<generation>:<attemptId>` for auto-fix) update a single row,
with `attemptCount` and timestamps carrying the history.

Query decisions read-only:

```bash
./run.sh --headless query worker-decisions --workflow <id> --output json
./run.sh --headless query worker-decisions --decision skip --reason budget
```

The desktop Workers tab surfaces the same feed: selecting a worker shows a
`Decisions` list (act vs skip, with reasons) backed by the
`invoker:get-worker-decisions` IPC channel.

Only the auto-fix and CI-failure workers own per-task decisions. The
PR-maintenance crons record coarse run-level rows (running → completed/failed);
the pr-status worker delegates its decisions to the review gate, and the
disk-headroom and external-process workers have no task/workflow decision to
record.

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
