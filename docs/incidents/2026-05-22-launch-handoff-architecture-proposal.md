# Launch-Handoff Architecture Proposal

Date: 2026-05-22
Status: Design (not yet planned via `/plan-to-invoker`).
Companion to: [`2026-05-22-launch-handoff-orphan-architecture.md`](./2026-05-22-launch-handoff-orphan-architecture.md) (the investigation).

## Purpose

Replace the fire-and-forget JavaScript-promise seam between `orchestrator.startExecution()` and `TaskRunner.executeTask()` with a durable, polled, single-source-of-truth dispatcher. Eliminate Issues 0–15 from the investigation as a class instead of patch-by-patch.

The proposal is **not** a rewrite. It is a targeted re-architecture of the launch handoff. The orchestrator state machine, the executor lifecycle, the DAG semantics, the pool selection, and the persistence layer are kept as-is.

## What already exists in the codebase that we can lean on

The exact pattern we need is already deployed elsewhere in this codebase:

- `workflow_mutation_intents` table — durable outbox for workflow mutations.
- `workflow_mutation_leases` table — per-workflow active-mutation lease.
- `PersistedWorkflowMutationCoordinator` (`packages/app/src/persisted-workflow-mutation-coordinator.ts`) — a mature outbox dispatcher with priority, supersession, heartbeat renewal, lease takeover, and crash recovery.
- `execution_resource_leases` table — per-resource lease (used today for SSH pool members).

We are **not inventing a new pattern**. We are applying the same outbox pattern to launch dispatch.

## Invariants the new architecture must hold

The two new invariants that fix the regression:

1. **Durable-write/durable-recovery symmetry.** Every durable state change has a polled recovery owner. There is no durable state that depends on an in-memory promise to make progress.
2. **No in-memory dispatch ownership across process boundaries or task batches.** All cross-task, cross-process coordination goes through SQLite, not through JS objects.

Five derived invariants worth stating explicitly:

3. **One TaskRunner per process.** Headless commands and mutations do not instantiate their own `TaskRunner`. They enqueue into the outbox; the owner's `TaskRunner` services it.
4. **Capacity is enforced at dispatch time, not at claim time.** The orchestrator can enqueue freely. The dispatcher enforces `maxConcurrency` when it tries to lease an outbox row.
5. **Every `task.launch_claimed` is followed within bounded time by exactly one terminal launch event**: `task.executor.selected | task.executor.deferred | task.executor.startup-retry | task.failed-with-startup-error | task.prepared_for_new_attempt`. This is the regression-test invariant.
6. **Process restart is recovery.** All in-memory state is derivable from durable state. There is no "you must restart Invoker" recovery path; the dispatcher does the same thing on startup as on tick N.
7. **Single source of truth for time-outs and leases.** One module owns `ATTEMPT_LEASE_MS`, one owns `DISPATCH_LEASE_MS`, one owns `EXECUTING_HEARTBEAT_TIMEOUT_MS`.

## Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 1: STATE  (packages/workflow-core, unchanged shape)                    │
│  Pure DAG state machine. Workflows, tasks, dependencies, attempts.           │
│  All transitions are (state, event) → state via the repository.              │
│  No knowledge of executors, pools, processes, or time-outs.                  │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  │ Orchestrator.startExecution() / handleWorkerResponse()
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 2: SCHEDULING POLICY  (small new module in workflow-core)              │
│  Pure function: (ready_tasks, ...) → tasks_to_enqueue.                       │
│  Idempotent; re-runnable any time without side effects.                      │
│  Replaces the half-used in-memory TaskScheduler with a stateless planner.    │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  │ launchOutbox.enqueue(taskId, attemptId, priority)
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 3: LAUNCH OUTBOX  (NEW: task_launch_dispatch table + LaunchDispatcher) │
│  Durable seam. Modeled on workflow_mutation_intents.                         │
│  States: enqueued → leased → acknowledged → completed/abandoned.             │
│  Short dispatch lease (30 s) — quick recovery; no 20-minute orphans.         │
│  Enforces maxConcurrency at lease time.                                      │
│  Polled by a single LaunchDispatcher in the owner process.                   │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  │ atomically lease + hand to the local TaskRunner
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 4: TASKRUNNER  (packages/execution-engine, mostly unchanged)           │
│  Per-task executor lifecycle: select → start → output/heartbeat → complete.  │
│  ACKs the outbox on entry; completes the outbox on exit.                     │
│  Stateless across crashes — all state derivable from DB.                     │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  │ task.executor.selected, task.running, task.completed, …
                  ▼
              (back to Layer 1 via Orchestrator.handleWorkerResponse)
```

### Why these four layers

Each layer has a single responsibility and a single concurrency model:

- **Layer 1 (State)** is a pure state machine. It does not know about wall-clock time, executors, or processes. Today's `Orchestrator` already has this shape; the launch-claim writes inside `drainScheduler` are the only thing that violate it.
- **Layer 2 (Policy)** is a pure function. Today's `TaskScheduler` half-implements this; we strip it down. Re-running the planner is always safe and produces the same result.
- **Layer 3 (Outbox)** is the only durable, persisted, polled component. It is the single point where the "what should we launch" decision meets the "what is currently launching" reality. Today this layer does not exist; the fire-and-forget JS promise is its degenerate placeholder.
- **Layer 4 (Runner)** is per-task in-memory state with crash-safe ack/complete semantics. Today's `TaskRunner` already has this shape; we add explicit outbox ACK/COMPLETE calls and strip the `launchingAttemptIds`/`activeExecutions` cross-task accounting (the DB owns it).

## The `task_launch_dispatch` outbox

### Schema (mirrors `workflow_mutation_intents`)

```sql
CREATE TABLE IF NOT EXISTS task_launch_dispatch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'enqueued',
      -- 'enqueued' | 'leased' | 'acknowledged' | 'completed' | 'abandoned'
  priority TEXT NOT NULL DEFAULT 'normal',
  dispatch_owner TEXT,          -- runner instance id + pid; null while enqueued
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  leased_at TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  fenced_until TEXT,            -- dispatch lease expiry (short: 30 s)
  attempts_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  generation INTEGER NOT NULL,  -- copied from the task at enqueue time
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE UNIQUE INDEX idx_task_launch_dispatch_active_attempt
  ON task_launch_dispatch(attempt_id)
  WHERE state IN ('enqueued', 'leased', 'acknowledged');

CREATE INDEX idx_task_launch_dispatch_ready
  ON task_launch_dispatch(state, priority, id)
  WHERE state IN ('enqueued', 'leased');

CREATE INDEX idx_task_launch_dispatch_workflow_state
  ON task_launch_dispatch(workflow_id, state);
```

The unique index on `attempt_id` (filtered to non-terminal states) makes "one active dispatch per attempt" a database invariant, not a code rule.

### State machine

```
              ┌─────────┐
              │enqueued │ ◄── orchestrator.enqueueLaunch(taskId, attemptId)
              └────┬────┘
                   │ dispatcher.tryLease() — atomic, enforces maxConcurrency
                   ▼
              ┌─────────┐  fenced_until expires (TaskRunner crashed / never ran)
              │ leased  │ ─────────────────────────────► dispatcher resets to enqueued
              └────┬────┘                                  (incr attempts_count)
                   │ TaskRunner.executeTask() called runner.ackDispatch()
                   ▼
            ┌──────────────┐  fenced_until expires (TaskRunner started but is stuck)
            │ acknowledged │ ────────────────────────────► dispatcher abandons + relaunches
            └──────┬───────┘                                 via prepareTaskForNewAttempt
                   │ markTaskRunningAfterLaunch + executor finishes
                   ▼
              ┌──────────┐         ┌───────────┐
              │completed │   OR    │ abandoned │  (after attempts_count >= max)
              └──────────┘         └───────────┘
```

Three timer-driven transitions, all polled, all atomic SQL:

1. `enqueued → leased`: `UPDATE … SET state='leased', dispatch_owner=?, leased_at=?, fenced_until=datetime('now','+30 seconds'), attempts_count=attempts_count+1 WHERE state='enqueued' AND id=(SELECT id FROM task_launch_dispatch WHERE state='enqueued' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id LIMIT 1) AND (SELECT COUNT(*) FROM task_launch_dispatch WHERE state IN ('leased','acknowledged')) < ?`. Enforces priority + capacity in one statement.
2. `leased → enqueued` (timeout): `UPDATE task_launch_dispatch SET state='enqueued', dispatch_owner=NULL, fenced_until=NULL, last_error=? WHERE state='leased' AND fenced_until < datetime('now')`.
3. `acknowledged → abandoned` (final orphan): after `attempts_count >= max_attempts` and `fenced_until < now`, mark `abandoned`, write `task.failed` with a real error message, and let `prepareTaskForNewAttempt` decide whether to make a fresh attempt.

### Companion changes to the existing `tasks` / `attempts` tables

Almost nothing changes. The `task.launch_claimed` event is **still** emitted by the orchestrator when an attempt is durably claimed, but only after the dispatcher leases the outbox row. The `attempt.leaseExpiresAt` 20-minute lease still exists for executing work but is no longer the recovery window for stuck launches — the 30 s dispatch lease is.

The `task.execution.phase` field gets a new value:

- `enqueued` (NEW): outbox row exists, dispatcher hasn't leased it yet.
- `launching` (existing): dispatcher leased; TaskRunner is selecting executor / starting.
- `executing` (existing): TaskRunner has called `markTaskRunningAfterLaunch`.
- `completed` / `failed` / etc. (existing).

This gives operators a clear way to see "is this task stuck because nothing is dispatching, or stuck because dispatch started and the executor hung?"

## Component responsibilities and interfaces

### `Orchestrator` (Layer 1, modified)

Keeps its current API. Three changes inside:

- `startExecution()` returns `TaskState[]` as today, but those tasks have `phase: 'enqueued'`, not `'launching'`. The durable claim event becomes `task.dispatch_enqueued` (carrying the new outbox row id).
- `drainScheduler` no longer writes `attempts.status='claimed'`. It calls `launchOutbox.enqueue({taskId, attemptId, priority, generation})` inside the same transaction as the attempt creation, and emits `task.dispatch_enqueued`.
- `markTaskRunningAfterLaunch(taskId, attemptId)` continues to exist but now also calls `launchOutbox.markAcknowledged(dispatchId)` and `launchOutbox.markCompleted(dispatchId)` at the appropriate moments. (The orchestrator does not own the outbox state machine — `LaunchDispatcher` does — but the orchestrator coordinates the per-attempt linkage.)

### `LaunchScheduler` (Layer 2, simplified)

Replaces the current `TaskScheduler` class. Pure function:

```ts
function planLaunches(input: {
  readyTasks: TaskState[];          // from Orchestrator.getReadyTasks()
  externalGateBlocker: (task: TaskState) => boolean;
}): Array<{ taskId: string; attemptId: string; priority: 'low'|'normal'|'high' }> {
  return input.readyTasks
    .filter((task) => !input.externalGateBlocker(task))
    .map((task) => ({
      taskId: task.id,
      attemptId: ensurePendingAttempt(task).id,
      priority: priorityOf(task),
    }));
}
```

No state. No `running` map. No concurrency check (the dispatcher owns that). Idempotent enqueue via the unique index on `attempt_id`.

### `LaunchDispatcher` (Layer 3, new)

Modeled on `PersistedWorkflowMutationCoordinator`. Owner-only.

```ts
interface LaunchDispatcher {
  // Called every poll tick (e.g. 250 ms) from the existing db-poll loop.
  poll(): Promise<void>;

  // Called by orchestrator after enqueue, to nudge the dispatcher if it's idle.
  notifyEnqueued(): void;

  // Called by TaskRunner.executeTask on entry, before any executor work.
  ackDispatch(dispatchId: number, owner: string): boolean;

  // Called by TaskRunner after markTaskRunningAfterLaunch succeeds.
  completeDispatch(dispatchId: number): void;

  // Called by TaskRunner if executor startup fails after a launch was leased.
  failDispatch(dispatchId: number, error: string): void;

  // Periodic / on-tick: reset 'leased' rows whose fenced_until expired.
  reapExpiredLeases(): number;

  // Periodic / on-tick: abandon 'acknowledged' rows whose attempts_count >= max.
  abandonStuckLeases(): TaskState[];
}
```

`poll()` does, in order:

1. `reapExpiredLeases()` — leased rows whose dispatcher crashed go back to `enqueued`.
2. `abandonStuckLeases()` — acknowledged rows that have re-tried `max_attempts` get a real failure event and a fresh attempt via the orchestrator.
3. Loop while `currentCapacity() > 0` and an `enqueued` row exists:
   a. Atomically transition `enqueued → leased` (the single SQL above).
   b. Build a `TaskState` from the leased row.
   c. Hand it to the local `TaskRunner.executeTask(task, dispatchId)`. Fire-and-forget within the dispatcher's own loop (the row is durable; if this call drops, the next poll re-leases after `fenced_until` expiry).

`currentCapacity()` reads `SELECT (SELECT max_concurrency FROM invoker_config) - COUNT(*) FROM task_launch_dispatch WHERE state IN ('leased','acknowledged')` — capacity is DB-derived, single query.

### `TaskRunner` (Layer 4, lightly modified)

Three changes:

- `executeTask(task, dispatchId)`: the entry point takes the dispatch row id. Immediately calls `launchOutbox.ackDispatch(dispatchId, runnerInstanceId)`. If `ackDispatch` returns false (lease was reaped by another runner), bail out.
- The internal `launchingAttemptIds` Set is removed. Dedup is by the unique outbox-row index.
- `markTaskRunningAfterLaunch` success path also calls `launchOutbox.completeDispatch(dispatchId)` (in the same transaction would be ideal; if not, on a best-effort basis with a follow-up reaper).
- Errors thrown during executor selection/startup call `launchOutbox.failDispatch(dispatchId, error)`. The dispatcher decides whether to retry (`enqueued`) or abandon (`abandoned`) based on `attempts_count`.

### Removed

- `relaunchOrphansAndStartReady`: folded into `LaunchDispatcher.reapExpiredLeases` + `abandonStuckLeases`. On startup, the dispatcher's first `poll()` does the same recovery as on any other tick.
- `evaluateLaunchStall` and the two stall watchdogs in `main.ts`: replaced by the dispatcher's lease-expiry loop. The watchdog stops being a sentinel-that-fails and becomes a participant in the recovery loop.
- The in-memory `launchingTasks` Set in `main.ts`: replaced by an indexed DB query (`WHERE state IN ('leased','acknowledged')`).
- The `running` / `dequeue` / `completeJob` / `getRunningJobs` surface of `TaskScheduler`: dead code paths deleted; `TaskScheduler` becomes the pure function in Layer 2.

## Sequence diagrams

### Happy path: one launch

```
Caller         Orchestrator      LaunchScheduler   LaunchOutbox    LaunchDispatcher    TaskRunner    Executor
  │  startExecution()│                 │                  │                 │              │            │
  │─────────────────►│                 │                  │                 │              │            │
  │                  │  planLaunches() │                  │                 │              │            │
  │                  │────────────────►│                  │                 │              │            │
  │                  │◄────────────────│                  │                 │              │            │
  │                  │       enqueue({task,attempt})       │                │              │            │
  │                  │────────────────────────────────────►│                 │              │            │
  │                  │     (event: task.dispatch_enqueued) │                 │              │            │
  │                  │                 │                  │  notifyEnqueued()│              │            │
  │                  │                 │                  │────────────────►│              │            │
  │                  │                 │                  │   poll() loops  │              │            │
  │                  │                 │                  │◄────────────────│              │            │
  │                  │                 │  tryLease() atomic SQL              │              │            │
  │                  │                 │                  │◄────────────────│              │            │
  │                  │                 │                  │   row → leased  │              │            │
  │                  │                 │                  │     executeTask(task, dispatchId)            │
  │                  │                 │                  │                 │─────────────►│            │
  │                  │                 │                  │       ackDispatch(dispatchId, owner)         │
  │                  │                 │                  │◄─────────────────────────────│            │
  │                  │                 │                  │   row → acknowledged          │            │
  │                  │  task.launch_claimed (event)        │                                │            │
  │                  │◄────────────────────────────────────────────────────────────────────│            │
  │                  │                 │                  │                 │              │ executor.start()
  │                  │                 │                  │                 │              │───────────►│
  │                  │                 │                  │                 │              │◄───────────│
  │                  │  markTaskRunningAfterLaunch()       │                 │              │            │
  │                  │◄────────────────────────────────────────────────────────────────────│            │
  │                  │                 │                  │   completeDispatch(dispatchId)│            │
  │                  │                 │                  │◄─────────────────────────────│            │
  │                  │                 │                  │   row → completed             │            │
```

### Failure path 1: dispatch promise dropped (the original bug)

```
Orchestrator   LaunchOutbox    LaunchDispatcher    TaskRunner
   │  enqueue({task,attempt})   │                 │
   │────────────────────────────►│                 │
   │   row=42 state=enqueued     │                 │
   │                             │ poll → tryLease │
   │                             │◄────────────────│
   │                             │ row=42 → leased │
   │                             │ fenced_until=now+30s
   │                             │ executeTask(task, 42)
   │                             │────────────────────────────►X (call drops, JS engine hiccup)
   │                             │                 │
   │                             │ ... 30 s pass ...
   │                             │ poll → reapExpiredLeases
   │                             │◄────────────────│
   │                             │ row=42 → enqueued (attempts_count=1)
   │                             │ poll → tryLease
   │                             │◄────────────────│
   │                             │ row=42 → leased │
   │                             │ executeTask(task, 42)
   │                             │────────────────────────────►│ ack → run → complete
```

Recovery is automatic and bounded by `fenced_until` (30 s), not by `leaseExpiresAt` (20 min). No `task.failed` is emitted unless `attempts_count` reaches `max_attempts`.

### Failure path 2: executor hangs during start()

```
LaunchDispatcher    TaskRunner    Executor
       │ executeTask(task, 42)
       │────────────────────►│ ackDispatch(42)
       │◄────────────────────│
       │ row=42 → acknowledged
       │                     │ executor.start()
       │                     │─────────────►█ (hung)
       │                     │ preStartHeartbeat renews dispatch lease every 10s
       │                     │  ackDispatch keeps fenced_until rolling
       │                     │
       │  attempts_count >= max_attempts after N retries
       │                     │
       │  abandonStuckLeases:
       │    failDispatch(42, "executor.start() hung > startup_timeout × max_attempts")
       │    write task.failed
       │    prepareTaskForNewAttempt() — creates a fresh attempt
       │    LaunchScheduler.planLaunches enqueues the new attempt
```

The pre-start heartbeat now renews **both** the attempt lease (for "is this attempt still owned") and the dispatch lease (for "is this dispatch still alive"). Either can serve as the orphan trigger.

### Failure path 3: process restart mid-launch

```
T = 0     Orchestrator enqueues row 42 → enqueued
T = 1     Dispatcher leases row 42 → leased, fenced_until = T+30
T = 2     TaskRunner calls ackDispatch → acknowledged
T = 3     executor.start() running, preStart heartbeat at T+10, T+20
T = 25    OWNER PROCESS RESTARTS

(Owner comes back up)
T = 35    Dispatcher.poll(): fenced_until=30 < now=35 → row 42 reaped to enqueued, attempts_count=2
T = 35    Dispatcher.tryLease → row 42 → leased
T = 35    TaskRunner.executeTask(task, 42) → ackDispatch → executor.start() → ...
```

Process restart is just another `fenced_until` expiry. No special "orphan relaunch" code path on startup; the dispatcher does the same thing every poll. (We can still keep a startup hook that calls `dispatcher.poll()` once eagerly, but it is no longer special.)

## Mapping: current code → target architecture

| Current code | Target | Notes |
|---|---|---|
| `Orchestrator.drainScheduler` (writes claim, lease, `phase='launching'`, emits `task.launch_claimed`, returns `TaskState[]`) | `Orchestrator.drainScheduler` writes the attempt as `pending` (no `claimed`), emits `task.dispatch_enqueued`, calls `launchOutbox.enqueue()`, returns `TaskState[]` for callers that want to know what was enqueued. | The 20-minute lease moves to executing-phase only. |
| `TaskScheduler` (in-memory priority queue, half-used `running` set) | `LaunchScheduler` (pure `planLaunches` function) | Delete `running`, `dequeue`, `completeJob`, `getRunningJobs`. |
| `global-topup.ts:dispatchTasks` (fire-and-forget JS promise) | Deleted. All callers replace `executeTasks(started)` with `orchestrator.startExecution()` (which already enqueues) and stop. | The IDs are already in the outbox by the time `startExecution` returns. |
| `global-topup.ts:executeGlobalTopup`, `dispatchStartedTasksWithGlobalTopup`, `finalizeMutationWithGlobalTopup` | Reduced to thin wrappers that just call `orchestrator.startExecution()` for the appropriate scope. | The "global top-up" effect is automatic — the dispatcher always picks the highest priority `enqueued` row first. |
| `relaunchOrphansAndStartReady` | Deleted. | Replaced by `LaunchDispatcher.poll()` which runs the same logic every tick. |
| `evaluateLaunchStall` + `[launch-stall] forcing failure` watchdog in `main.ts:2566–2611` | Deleted. | The dispatcher's `reapExpiredLeases` and `abandonStuckLeases` are the replacements. The `[executing-stall]` watchdog at 2615–… stays (different concern: executor stopped heartbeating after launch). |
| `launchingTasks` Set in `main.ts:1266` + `onLaunchAccepted`/`onLaunchStart`/`onSpawned`/`onLaunchSettled` callbacks | Deleted. Capacity and "is this launching" answered by `SELECT … FROM task_launch_dispatch WHERE state IN ('leased','acknowledged')`. | Removes the multi-TaskRunner blindness. |
| `createHeadlessExecutor` + every `new TaskRunner` in headless paths | Deleted. | Headless commands enqueue into the outbox; the owner's `TaskRunner` services it. |
| `TaskRunner.executeTasks(tasks)` and `TaskRunner.executeTask(task)` | `TaskRunner.executeTask(task, dispatchId)`. The plural form is removed; the dispatcher loop is the only entry. | `Promise.all` race collapses. |
| `TaskRunner.launchingAttemptIds` Set | Deleted. Dedup by the outbox unique index. | |
| `markTaskRunningAfterLaunch` | Adds `launchOutbox.completeDispatch(dispatchId)`. | Same lifecycle event; one new line. |
| `deferTask` (resource-limit defer) | Calls `launchOutbox.deferDispatch(dispatchId, reason)` which transitions the row back to `enqueued` with a delayed `available_after_at` field. | Defer becomes a first-class outbox state instead of a separate `deferredTaskIds` Set. |
| `ATTEMPT_LEASE_MS = 20 * 60 * 1000` in two files | Consolidated into one constant in `@invoker/contracts`. | `DISPATCH_LEASE_MS = 30_000` added there too. |
| Pre-start heartbeat (`task-runner.ts:776`) | Renews both the attempt lease and the dispatch lease. | One additional `UPDATE task_launch_dispatch SET fenced_until=…` in the existing tick. |

## Issue elimination matrix

| Issue | What the new architecture does |
|---|---|
| **0** Durable launch claim with non-durable dispatch | **Eliminated.** Outbox row is the durable companion. A dropped JS promise just means the row stays `leased` and is reaped 30 s later. |
| **1** Watchdog error message lies about elapsed time | **Eliminated.** No more launch-stall watchdog; the dispatcher's retry log carries `attempts_count` and real wall-clock since `leased_at`. |
| **2** Orphan-relaunch not wired to db-poll | **Eliminated.** `LaunchDispatcher.poll()` is the recovery, runs every tick, no special startup path. |
| **3** Scheduler `running` set is dead code | **Eliminated.** `TaskScheduler` reduced to a pure function; the dead state is deleted, not patched. |
| **4** `takeNext` is destructive without re-insert | **Eliminated.** The outbox row is the queue entry; nothing pops it without an atomic state transition. Re-enqueue is just an UPDATE. |
| **5** Launching tasks count against `maxConcurrency` for 20 minutes | **Eliminated.** Capacity is gated by `state IN ('leased','acknowledged')` and the dispatch lease is 30 s, not 20 min. |
| **6** Multi-TaskRunner: per-instance Sets/Maps | **Eliminated.** One TaskRunner per process. Headless paths enqueue into the outbox; the owner services them. |
| **7** Fire-and-forget recursion inside `executor.onComplete` | **Eliminated by removal.** Completion calls `orchestrator.handleWorkerResponse` → newly ready tasks → `orchestrator.startExecution` → outbox enqueue. No fire-and-forget call. |
| **8** `Promise.all` rejection bypasses per-task safety net | **Eliminated.** `executeTasks` plural form is removed. The dispatcher iterates one row at a time. |
| **9** Watchdog cascades re-reproduce the bug | **Eliminated by removal.** Cascade dispatch is gone; everything goes through enqueue. |
| **10** Pre-start heartbeat masks a hung `executor.start()` | **Mitigated.** Pre-start heartbeat still exists, but `attempts_count` is incremented on every dispatcher re-lease, so a wedged `executor.start()` eventually hits `abandonStuckLeases` and gets a real `task.failed`. |
| **11** `ATTEMPT_LEASE_MS` duplicated | **Eliminated.** Single source of truth in `@invoker/contracts`. |
| **12** `markTaskRunningAfterLaunch` rejection silently leaves DB in `launching` | **Eliminated.** The dispatch row goes to `abandoned` and a fresh attempt is created via `prepareTaskForNewAttempt`. |
| **13** Pivot/spawn-experiments skips `markTaskRunningAfterLaunch` | **Targeted fix.** The pivot path also calls `launchOutbox.completeDispatch(dispatchId)`. Not eliminated by architecture alone — pivot is a special case — but the fix is local and unmistakable. |
| **14** SSH pool-selection lease can leak | **Out of scope for the launch architecture**, but the dispatcher's `abandonStuckLeases` includes a "release related pool leases" hook so abandoned dispatches drop their SSH leases. |
| **15** Regression repro tests inverse condition | **Replaced.** The new regression repro asserts the `task.dispatch_enqueued → terminal launch event` invariant. The inverted SQL is deleted. |

Twelve of the fifteen issues are eliminated by the architecture itself. Two more (13, 14) become small, local, well-defined fixes. One (15) is a one-line test rewrite.

## Migration plan

The new architecture can be rolled in incrementally behind a feature flag. Four phases:

**Phase A — Outbox installed in parallel (zero behavior change).**

1. Add `task_launch_dispatch` table + migration.
2. In `drainScheduler`, write the outbox row in the same transaction as the existing claim. The row is informational only.
3. Add `LaunchDispatcher` as a passive observer that reads the outbox and logs but takes no action.
4. Add the regression-repro test that asserts the launch-claimed → terminal-event invariant. It will fail; we accept that failure as the baseline.

This phase originally shipped as an observer before task launching moved to the
durable outbox.

**Phase B — Outbox owns dispatch.**

1. `LaunchDispatcher.poll()` becomes the active dispatcher.
2. `global-topup.ts:dispatchTasks` becomes a no-op; the outbox is the dispatcher.
3. The `[launch-stall]` watchdog in `main.ts` becomes obsolete.
4. Headless execution reuses the owner TaskRunner for launch-dispatch handoff.

The rollout flag was removed after dogfood. The durable outbox is now the only
launch path.

**Phase C — Cleanup.**

1. Delete `TaskScheduler.running`/`dequeue`/`completeJob`/`getRunningJobs`/`isRunning`.
2. Delete `relaunchOrphansAndStartReady`.
3. Delete `evaluateLaunchStall` and the launch-stall watchdog block in `main.ts`.
4. Delete `launchingTasks` Set and the `onLaunchAccepted`/`onLaunchSettled` callbacks (keep `onSpawned`/`onComplete` for the UI).
5. Delete `global-topup.ts:dispatchTasks` and the fire-and-forget path; `executeGlobalTopup` becomes a wrapper around `orchestrator.startExecution()`.
6. Consolidate `ATTEMPT_LEASE_MS` and `DISPATCH_LEASE_MS` constants in `@invoker/contracts`.
7. Delete the feature flag.

**Phase D — Targeted fixes for the residual issues.**

1. Pivot/spawn-experiments completion (Issue 13).
2. SSH pool-lease release hook in `abandonStuckLeases` (Issue 14).
3. Replace `repro-rebase-recreate-storm-launch-stall.sh` with the new invariant repro (Issue 15).

## Testing strategy

Three layers of test:

1. **Pure unit tests** of `LaunchScheduler.planLaunches` (deterministic, no DB).
2. **`@invoker/data-store` tests** that exercise the outbox SQL transitions directly: lease conflict, fenced_until expiry, max-attempts abandonment, unique-index enforcement. Mirror the existing `workflow-mutation-intents` tests.
3. **Integration tests** for the launch-claimed → terminal-event invariant, run under four scenarios:
   - Happy path (single task, single mutation).
   - Storm (38 concurrent rebase-recreates) — the exact incident shape.
   - Dropped dispatch (inject a synthetic JS promise rejection right after `ackDispatch`).
   - Process restart between `acknowledged` and `markTaskRunningAfterLaunch`.

All four scenarios must produce one of the five terminal launch events within `2 × DISPATCH_LEASE_MS × max_attempts`, regardless of how the dispatch was perturbed.

## Open questions

1. **Should `task.launch_claimed` keep its current event name or be renamed?** I propose `task.dispatch_enqueued` for the outbox enqueue and reusing `task.launch_claimed` for the moment the dispatcher leases the row (i.e. when work actually begins). This keeps log-grep compatibility for the existing operator tooling.
2. **Where does the dispatcher run in follower mode?** The current code disables most dispatch in follower mode. I propose: outbox enqueue is always allowed (durable, harmless), but `LaunchDispatcher.poll()` is gated to owner mode. Followers see the outbox grow until the owner catches up.
3. **Do we want a per-workflow concurrency limit?** Today only `maxConcurrency` is global. The outbox makes per-workflow limits trivial: `WHERE workflow_id = ? AND state IN ('leased','acknowledged')`. This is out of scope for this proposal but worth flagging as a future capability the outbox enables for free.
4. **What is the right `max_attempts` value?** I propose 3 as a starting point: 30 s + 30 s + 30 s of dispatch retries before giving up and writing a real `task.failed`. Tunable via env var.
5. **Should we keep the 20-minute attempt lease at all once the outbox is in place?** Probably yes for `executing` work (long-running real tasks), but the value can be revisited. The dispatch lease (30 s) is the new short-cycle recovery; the attempt lease becomes "this attempt is still owned by some runner instance" rather than "this launch claim is still valid."

## Recommendation

Adopt this proposal. The implementation cost is well-scoped (one new table, one new dispatcher modeled on a coordinator we already have, a handful of deletions, one feature flag) and the cumulative cost of point-fixes over the last nine PRs already exceeds it. The architecture pays for itself in two ways: it eliminates the regression class, and it removes ~500 lines of accumulated workaround code (`launchingTasks`, `relaunchOrphansAndStartReady`'s scattered call sites, the two stall watchdogs in `main.ts`, the half-used `TaskScheduler` internals, and the four fire-and-forget dispatch sites in `global-topup.ts`).

If we proceed, my recommended next concrete step is **Phase 1 (Reproduce) of the existing bug-fix policy**: write the launch-claimed → terminal-event invariant test against the current head, get it failing on the storm scenario, and use that as the gate for Phase A of the migration above.
