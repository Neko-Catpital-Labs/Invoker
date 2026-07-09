# Launch-Handoff Orphan Architecture Review

Date: 2026-05-22
Status: Investigation complete (Phase 2 of the bug-fix policy). No code changes yet.
Owner: TBD

## Summary

During a workflow-mutation storm (38 concurrent `headless.exec rebase-recreate` mutations queued in ~50 ms at `2026-05-22T01:55:56`), four tasks remained in `pending/launching` for ≈20 minutes each before the db-poll watchdog force-failed them. The misleading `Launch stalled: …60s without a spawned execution handle` log lines hide the real timing: the watchdog cannot fire until the 20-minute attempt lease expires (added by `35c0ad97 "Guard launch stalls with live attempt leases"`).

The proximate cause is a single design seam: **the launch claim is durably written (`task.launch_claimed`, attempt `claimed` with 20-minute lease, `phase: 'launching'`) before the actual handoff to a `TaskRunner` is durable**. The handoff itself is a fire-and-forget JavaScript promise (`global-topup.ts:dispatchTasks`, with the author's own `// TODO: replace app-level workflow mutation leases with atomic DB state transitions plus an outbox for launch/cancel side effects.` next to it). When that promise is dropped — by a microtask race, a synchronous throw, a transient TaskRunner instance going out of scope, or any other in-memory perturbation — the DB is left in `pending/launching` with no in-memory state holding a recovery reference. The only thing that eventually fires is the watchdog, which marks the task `failed` instead of relaunching it.

The investigation also surfaced **14 additional issues** in the queue/dispatch/executor pipeline that are independent of the original orphan bug but share the same underlying architectural pattern. The cumulative picture indicates this subsystem has accreted point-fixes over at least nine PRs and is now overdue for a focused redesign of the launch handoff itself.

## Evidence (incident log, `~/.invoker/invoker.log`)

- `2026-05-22T01:55:56.217Z` and the ~50 ms following: 38 `executeHeadlessExec begin args="rebase-recreate ..."` intents (intentIds 3887–3924+).
- `2026-05-22T02:20:09.590Z` first launch-stall force-fail:
  ```
  [launch-stall] detected task="wf-1778431097453-46/implement-inv-117" phase=launching launchAgeMs=1201165 handlePresent=false
  [launch-stall] forcing failure for "wf-1778431097453-46/implement-inv-117":
    Launch stalled: task remained in running/launching for 60s without a spawned execution handle
  ```
- Same shape at 02:21:47, 02:23:13, 02:25:54 with `launchAgeMs ≈ 1.2M ms` (≈20 min) in each.
- No intervening `task.executor.selected`, `task.executor.deferred`, `task.executor.startup-retry`, `task.running`, or concrete startup-error events between `task.launch_claimed` and the watchdog for any of the four tasks.

The watchdog message hardcodes "60s" from `launchingStallTimeoutMs / 1000` regardless of the observed `launchAgeMs` (`packages/app/src/main.ts:2582`). The actual delay is bounded below by the attempt lease (20 min) because of the `!launchLeaseActive` gate in `evaluateLaunchStall`.

## Full Execution-Path Trace

```
DB (durable)                             | In-memory (TaskRunner instance)
-----------------------------------------|------------------------------------
attempt.status='claimed' + 20m lease     |
task.status='pending', phase='launching' |
event task.launch_claimed                |
                                          \
                                           → Promise from dispatchTasks (fire-and-forget)
                                              ↓ (microtask)
                                           TaskRunner.executeTasks → executeTask
                                              ↓
                                           launchingAttemptIds.add (per-instance Set)
                                              ↓
                                           selectExecutor → pool lease (durable row)
                                              ↓
preStartHeartbeatTimer renews lease  ←──── setInterval (per-instance timer)
                                              ↓
                                           executor.start() (per-instance promise)
                                              ↓
task.running event, phase='executing'    ←  markTaskRunningAfterLaunch
attempt.status='running', lease renewed  ←
                                              ↓
                                           activeExecutions.set (per-instance Map)
                                              ↓
                                           executor.onComplete callback
                                              ↓
task.completed / task.failed             ←  handleWorkerResponse
```

### Hop 0 — Trigger: someone calls `orchestrator.startExecution()`

Callers in `packages/app/src/main.ts` and `packages/app/src/headless.ts` include:
- Owner startup (`init`)
- `resume-workflow`, `executeHeadlessRun`, `executeHeadlessResume`
- ~30 sites that follow the `const started = orchestrator.startExecution(); requireTaskExecutor().executeTasks(started).catch(...)` pattern
- `executeGlobalTopup` / `dispatchStartedTasksWithGlobalTopup` after mutations
- The two stall watchdogs themselves on cascade (`main.ts:2599`, `:2654`)

### Hop 1 — `startExecution()` → enqueue ready tasks

`packages/workflow-core/src/orchestrator.ts:1547–1567`. `refreshFromDb`, gather `getReadyTasks` filtered by external dependency blockers, enqueue each via `enqueueIfNotScheduled` into the in-memory `TaskScheduler.queue`, then call `drainScheduler`.

### Hop 2 — `drainScheduler()`: pop, durably claim, mark `pending/launching`

`packages/workflow-core/src/orchestrator.ts:4870–4988`. For each popped `TaskJob`:

1. `claimAttemptForLaunch` writes `attempts[id].status='claimed', claimedAt, leaseExpiresAt = now + 20m`.
2. `writeAndSync` writes `tasks.status='pending', execution.phase='launching', execution.launchStartedAt=now, execution.selectedAttemptId, execution.generation`.
3. `logEvent('task.launch_claimed', changes)` is appended.
4. The new `TaskState` is pushed onto the local `started` array.

After Hop 2 the **DB believes the task is launching for the next 20 minutes**, but nothing other than the caller's local `started` variable references the work in memory.

### Hop 3 — Caller hands `started` to a `TaskRunner`

The hot mutation path (`packages/app/src/global-topup.ts:88–110`):

```ts
// TODO: replace app-level workflow mutation leases with atomic DB state transitions plus an outbox for launch/cancel side effects.
const dispatchPromise = mutationTiming
  ? mutationTiming.span(spanName, ..., run)
  : Promise.resolve().then(run);
void dispatchPromise
  .then(() => bench(afterMark))
  .catch((err) => { logger?.error(`[global-topup] ${context}: asynchronous task dispatch failed: ${message}`); });
bench(`${afterMark}.accepted`);
return Promise.resolve();
```

`dispatchMode` defaults to `'fire-and-forget'` whenever `mutationTiming` is present (`global-topup.ts:170`, `:232`). Every workflow mutation supplies `mutationTiming`. So **every workflow mutation dispatches launches fire-and-forget**, decoupled from the durable claim, with the only failure path being a logger.error.

The non-mutation IPC paths use the simpler `requireTaskExecutor().executeTasks(started).catch(err => logger.error(...))` pattern — same fire-and-forget semantics, just without the `mutationTiming` wrapper.

### Hop 4 — `TaskRunner.executeTasks → executeTask` per task

`packages/execution-engine/src/task-runner.ts:416–423`:

```ts
async executeTasks(tasks: TaskState[]): Promise<void> {
  ...
  await Promise.all(tasks.map((task) => this.executeTask(task)));
}
```

Inside `executeTask` (`task-runner.ts:458–485`) the per-instance `launchingAttemptIds` Set is mutated and `onLaunchAccepted` callback is fired. `launchingAttemptIds` is per-TaskRunner; `onLaunchAccepted` is only wired in the owner's TaskRunner (`main.ts:1709`), not in headless-spawned ones.

### Hop 5 — `executeTaskInner → selectExecutor → pool lease → executor.start()`

`task-runner.ts:558–795`. Notable behaviours:

- `preStartHeartbeatTimer` (`task-runner.ts:776`) is a `setInterval` that renews `leaseExpiresAt = nextLeaseExpiry(now)` while `executor.start()` is awaited. This is what stops `launch-stall` from firing during slow SSH startups.
- `Promise.race([executor.start(...), startTimeout])` provides an outer upper bound, but only kicks in once `executor.start()` is actually awaited.
- Pool capacity errors throw a `ResourceLimitError` (wrapped as `cause`) which the outer catch (`task-runner.ts:492–495`) translates into `orchestrator.deferTask(taskId)`.

### Hop 6 — `markTaskRunningAfterLaunch` → `phase: 'executing'`

`task-runner.ts:893–910` → `orchestrator.ts:4996–5091`. Writes `task.running`, transitions `phase: 'executing'`, and resets the lease. If the orchestrator rejects (`attempt_mismatch`, `attempt_superseded`, `invalid_status`, `not_found`), the TaskRunner kills the spawned process and returns without emitting any `task.failed` event — leaving the old attempt's `pending/launching` row in place.

### Hop 7 — Output/heartbeat/completion wiring

`task-runner.ts:1005–1097`. Output, heartbeat (which renews the attempt lease again at `nextLeaseExpiry(now)`), and a serialized `onComplete` chain. Completion fans back through `handleWorkerResponse` → `drainScheduler` → recursive `this.executeTasks(newlyStarted)` (no `await`, no `.catch`).

## Catalog of Issues

The launch-claim orphan is **Issue 0**. The trace surfaced 14 additional issues; all are independent symptoms of the same architectural seam.

### Issue 0 — Durable launch claim with non-durable dispatch (the original bug)

- `drainScheduler` writes `task.launch_claimed`, a claimed attempt with a 20-minute lease, and `phase: 'launching'` (`orchestrator.ts:4917–4974`).
- The corresponding executor invocation is a fire-and-forget JavaScript promise (`global-topup.ts:dispatchTasks`).
- If the promise is dropped, no in-memory state recovers it; the only fallback is the watchdog.
- The watchdog (`evaluateLaunchStall` in `packages/app/src/launch-stall.ts:41–48`) requires `!launchLeaseActive`, so it cannot fire until the 20-minute lease expires.
- The watchdog action is `handleWorkerResponse({status: 'failed'})` — it never relaunches.

### Issue 1 — Watchdog error message is misleading

`packages/app/src/main.ts:2581–2582`:

```ts
const launchError =
  `Launch stalled: task remained in running/launching for ${Math.floor(launchingStallTimeoutMs / 1000)}s without a spawned execution handle`;
```

`launchingStallTimeoutMs` is the configured timeout (default 60_000). `launchAgeMs` (the real wall-clock age) is computed but never substituted into the error. Every observed launch-stall failure in the incident reports "60s" while `launchAgeMs ≈ 1.2M`.

### Issue 2 — Watchdog has no relaunch action; orphan-relaunch is wired to startup-only

`packages/app/src/orphan-relaunch.ts` exposes `relaunchOrphansAndStartReady`, which is the correct recovery primitive (`prepareTaskForNewAttempt` + re-enqueue). It is invoked at:
- `init` startup (`main.ts:2887`)
- `resume-workflow` (`main.ts:3032`)
- `headless` (`headless.ts:1386`)
- A handful of IPC delegate paths (`main.ts:853, 1086, 1913`)

It is **never** invoked from the db-poll loop. The watchdog has the trigger condition; orphan-relaunch has the recovery; they never meet. The only way to recover an orphaned `launching` claim in steady state today is to restart Invoker.

### Issue 3 — Scheduler's in-memory `running` set is dead code on the hot path

`packages/workflow-core/src/scheduler.ts`:

- `drainScheduler` calls `takeNext()` (`scheduler.ts:103`), which removes from `queue` but never adds to `running`.
- Only `dequeue()` (`scheduler.ts:114`) adds to `running`, and the orchestrator does not call it.
- `completeJob`, `isRunning`, `getRunningAttemptIds`, `getRunningTaskIds`, `killAll`, `getRunningJobs`, `getStatus().runningCount` all reflect an empty `running` set on the production path.

Capacity is correctly enforced via `countActivePersistedAttempts`, which goes back to the DB, but any code (including tests and instrumentation) that consults the scheduler's `running` view gets misleading answers.

### Issue 4 — `takeNext()` is destructive without re-insert

Three skip branches inside `drainScheduler` (`orchestrator.ts:4887, 4902, 4936`) all do `job = this.scheduler.takeNext(); continue;` — they pop and never re-insert. If a job is skipped because:

- `task.status !== 'pending'` (a stale-write race),
- the attempt is discarded,
- claim fails because someone else has it,

the job is gone from the scheduler. The only path back is the next `startExecution()`'s walk over `getReadyTasks`. A task in `pending/launching` is not "ready" — so a popped-and-skipped job can sit until orphan-relaunch is invoked (Issue 2).

### Issue 5 — Launching tasks count against `maxConcurrency` for 20 minutes

`packages/workflow-core/src/orchestrator.ts:1135–1153`:

```ts
private isAttemptLeaseActive(attempt, now) {
  if (!attempt) return false;
  if (isDiscardedAttempt(attempt)) return false;
  if (attempt.status !== 'claimed' && attempt.status !== 'running') return false;
  if (!attempt.leaseExpiresAt) return true;
  return attempt.leaseExpiresAt.getTime() >= now;
}

private isTaskExecutionActive(task, attempt, now) {
  if (attempt && this.isAttemptLeaseActive(attempt, now)) {
    return task.status === 'pending' || task.status === 'running' || task.status === 'fixing_with_ai';
  }
  return task.status === 'running' || task.status === 'fixing_with_ai';
}
```

A `pending/launching` task with an active 20-minute lease counts as active for capacity. Default `maxConcurrency = 3` (`orchestrator.ts:798`). **Three orphans starve the queue for 20 minutes at default settings.** Higher concurrencies merely raise the floor.

### Issue 6 — Multi-TaskRunner: per-instance Sets/Maps, owner watchdog blind to headless launches

`packages/app/src/headless.ts:195–243`: `createHeadlessExecutor` instantiates a fresh `TaskRunner` per headless command. The owner has its own long-lived `TaskRunner` (`main.ts:1671`). Each owns its own:

- `launchingAttemptIds` Set
- `activeExecutions` Map
- `pendingPoolSelections`
- `completionChain`

The owner's `launchingTasks` Set (`main.ts:1266`) is populated only by callbacks (`onLaunchAccepted`, `onLaunchStart`, `onSpawned`, `onLaunchSettled`) that are wired on the owner's TaskRunner. Headless TaskRunners don't pass these callbacks (`headless.ts:230–241`).

Consequences:
- The owner's watchdog has no in-memory state for any headless-launched task. The watchdog relies entirely on the attempt lease (Hop 5's pre-start heartbeat) to distinguish "currently launching" from "orphaned."
- Two TaskRunners can both call `executeTask` on the same task. The DB-level `claimAttemptForLaunch` deduplicates them, but only after both have walked through `selectExecutor`. Wasted work and noisier logs; a regression vector if either guard has a bug.

### Issue 7 — Fire-and-forget recursion inside `executor.onComplete`

`packages/execution-engine/src/task-runner.ts:1067–1069`:

```ts
if (newlyStarted.length > 0) {
  this.executeTasks(newlyStarted);
}
```

No `void`, no `await`, no `.catch`. A synchronous rejection in `executeTasks` (e.g. `resolveAttemptIdForStart` failing because `loadLatestAttemptId` raises) becomes an unhandled promise rejection. Same orphan mechanism as Issue 0, inside the executor instead of the caller.

The pattern repeats at `task-runner.ts:549–551` (post-launch-failure fallback) and `task-runner.ts:594–596` (pivot/spawn-experiments).

### Issue 8 — `Promise.all` rejection bypasses the per-task safety net

`packages/execution-engine/src/task-runner.ts:422`: `await Promise.all(tasks.map((task) => this.executeTask(task)))`. Per-task work is wrapped in try/catch inside `executeTask`, which translates exceptions into a `'failed'` `WorkResponse`. But if anything throws **between** `resolveAttemptIdForStart` and the `try` block (lines 462–482), the throw escapes the per-task safety net. `Promise.all` rejects with that one error; the fire-and-forget caller's `.catch` logs it; the other tasks in the batch are still running but uninstrumented at this seam.

### Issue 9 — Watchdog cascades reproduce the bug

`packages/app/src/main.ts:2599–2609` (launch-stall) and `:2655–2664` (executing-stall) both use the fire-and-forget pattern to dispatch downstream tasks unblocked by the watchdog's force-failure. The recovery action can spawn new orphans by the same mechanism, exponentially.

### Issue 10 — Pre-start heartbeat masks a hung `executor.start()`

`packages/execution-engine/src/task-runner.ts:776–784` sets a `setInterval` that renews `leaseExpiresAt = nextLeaseExpiry(now)` for the duration of `executor.start()`. If `executor.start()` hangs indefinitely (e.g. SSH connect deadlock before `startTimeoutMs` can take effect, or a worktree-add that never returns), the heartbeat keeps renewing the lease. `launch-stall` cannot fire (lease always active). `executing-stall` doesn't apply (phase is still `launching`). The task is stuck in `launching` until `Promise.race` resolves to the timeout — which assumes the timeout fires reliably and that nothing in the start path can drop it.

### Issue 11 — `ATTEMPT_LEASE_MS` is duplicated in two packages

- `packages/workflow-core/src/orchestrator.ts:111`: `const ATTEMPT_LEASE_MS = 20 * 60 * 1000;`
- `packages/execution-engine/src/task-runner.ts:66`: same constant, same value.

Both expose a local `nextLeaseExpiry`. Any change to one without the other (or to `INVOKER_LAUNCHING_STALL_TIMEOUT_MS = 60_000` in `main.ts:1301`) produces silent skew across the launch-stall window.

### Issue 12 — `markTaskRunningAfterLaunch` rejection silently leaves DB in `launching`

`packages/execution-engine/src/task-runner.ts:893–909`. When the orchestrator rejects the transition (attempt superseded by a concurrent recreate/cancel during `executor.start()`), the spawn is killed and the function returns without emitting any task event. The DB still reflects `pending/launching` for the old attempt; the task may already have a fresh attempt from `prepareTaskForNewAttempt`. The launch-stall watchdog will eventually pick up the old attempt's orphan.

### Issue 13 — Pivot/spawn-experiments path skips `markTaskRunningAfterLaunch`

`packages/execution-engine/src/task-runner.ts:572–601`: for `task.config.pivot && experimentVariants.length > 0`, the inner method synthesizes a `spawn_experiments` `WorkResponse` and routes it through `handleWorkerResponse`. The parent task is left in `pending/launching` because the pivot path never calls `markTaskRunningAfterLaunch`. The parent's slot is held until the lease expires (Issue 5), then the watchdog fails it.

### Issue 14 — SSH pool-selection lease can leak on early exception

`packages/execution-engine/src/task-runner.ts:1213–1255`. The release sites at `:868, :904, :916, :985–986, :1047` cover the normal flow, but an exception thrown between `selectExecutor` releasing the early `pendingPoolSelections` entry and the proper acquisition can leave the SSH resource lease held with no in-memory owner. There is no watchdog for stale `execution_resource_lease` rows.

### Issue 15 — Regression repro tests the inverse condition of the current bug

`scripts/repro/repro-rebase-recreate-storm-launch-stall.sh:87–91`:

```sql
where lease_expires_at is not null
  and julianday(lease_expires_at) > julianday(created_at);
```

This counts launch-stall failures **only** where the lease was still active at failure time. After `35c0ad97 "Guard launch stalls with live attempt leases"`, the watchdog refuses to fire while the lease is active — so this check is structurally green on every real orphan. The CI gate has been guarding the wrong condition since that PR landed.

## How We Keep Missing This (Recurrence Analysis)

`git log --grep="launch.stall|launching|orphan.*launch|launch claim|launch handoff|outbox" -i`:

| Commit | Date | Intent | What it actually did |
|---|---|---|---|
| `0ece767c` Avoid false launch stalls during SSH startup | — | Slow-start tolerance | Tuned watchdog timing |
| `905af5ec` Fix duplicate task launch claims | — | Double-claim safety | Idempotency in the claim path |
| `b7cd9cc2` Fix launch prestart tracking | — | Memo a "launching" set | Added in-memory `launchingTasks` Set, used only as a gate in the watchdog |
| `06ae8ed7` Fix reset paths to clear stale launch metadata | — | Cleanup after reset | Reset path only |
| `a8a8001e` Guard stale launch poller after reset | — | More watchdog gating | Watchdog only |
| `19c73337` Dispatch tasks after review gate auto-approval | — | Missing call site | One new `executeTasks` call site |
| `32aaaa35` Dispatch tasks unblocked by launch-stall failures | — | Cascade after stall | Added the post-stall `executeTasks` chain (Issue 9 introduced here) |
| `ebf9cf3d` Fix launch dispatch gaps and harden launch-stall recovery | 2026-04-16 | Centralize dispatch & add orphan-relaunch | Added `orphan-relaunch.ts` and `launching-stall-watchdog.spec.ts`; did not wire orphan-relaunch into the db-poll loop |
| `35c0ad97 / 1be5852d` Guard launch stalls with live attempt leases | 2026-05-18 | Eliminate false positives | Added `!launchLeaseActive` to `evaluateLaunchStall`; converts false positives into 20-minute true positives that fail real work |

Three structural reasons this keeps coming back:

1. **Every PR patched one corner.** No PR introduced a durable companion record for the dispatch (an outbox), and no PR wired the existing recovery (`relaunchOrphansAndStartReady`) into the steady-state db-poll loop. The last PR (`35c0ad97`) made the symptom rarer at the cost of making each occurrence cost 20 minutes of capacity and an unrecoverable `task.failed`.
2. **Regression tests assert the symptom-side action, not the desired outcome.** `packages/app/e2e/launching-stall-watchdog.spec.ts` asserts that the watchdog fires (i.e. that we mark the task `failed`). It locks in the wrong recovery. `packages/app/src/__tests__/launch-stall.test.ts` is a pure-unit test of `evaluateLaunchStall`'s boolean gate. Neither tests the durable-claim → executor-event invariant.
3. **The most relevant repro tests the inverse condition** (Issue 15). The CI signal that should have caught a regression has been silently green-by-construction since 2026-05-18.

## Architectural Diagnosis

The subsystem has two correctly-designed halves and a brittle seam in the middle:

- **Left half (durable, in DB):** state machine, attempts, leases, events, persistence. Well-instrumented; transactions cover atomicity.
- **Right half (in-memory, in TaskRunner):** per-task state machine for spawn/heartbeat/complete, with `Promise.race` timeouts, retry loops, pool selection. Internally consistent inside one TaskRunner instance.
- **Middle seam (fire-and-forget dispatch promise):** a single in-memory promise that connects them, with no durable record of "this claim is being dispatched." The author's own `// TODO: ... outbox for launch/cancel side effects` next to this code (Hop 3) is exact.

Every issue in the catalog is a consequence of this seam:

- Issues 0, 7, 8, 9 are direct expressions of "the promise can be dropped."
- Issues 2, 4 are "we don't have a polled recovery on the durable side."
- Issues 3, 6 are "we don't have a durable companion on the in-memory side."
- Issues 1, 11, 13, 15 are "test/instrumentation drift around the seam."
- Issues 5, 10, 12, 14 are "leases and slots become inconsistent across the seam."

## Recommended Direction: Targeted Re-Architecture

A focused redesign of the launch handoff, scoped tightly. **Not** a rewrite of the orchestrator or executor; both halves are sound. The proposal is to introduce a single new structure and route every launch through it:

### Proposal 1 — Launch-dispatch outbox (preferred)

Introduce a new persisted table `launch_dispatch`:

```
launch_dispatch (
  id PK,
  task_id NOT NULL,
  attempt_id NOT NULL,                       -- the durable claim
  state TEXT NOT NULL,                       -- 'pending' | 'dispatched' | 'completed' | 'abandoned'
  dispatch_owner TEXT,                       -- runner instance id + pid; null when pending
  enqueued_at NOT NULL,
  dispatched_at,
  acknowledged_at,                           -- when TaskRunner.executeTask first ran
  fenced_until,                              -- short-lived dispatch lease (e.g. 30s)
  attempts_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  generation INTEGER NOT NULL
);
```

Rule: **`drainScheduler` always writes a `launch_dispatch` row in the same transaction as the `task.launch_claimed` event.** No durable claim exists without a matching outbox row.

A new `LaunchDispatcher` polls `launch_dispatch` where `state='pending'` (or `dispatched` with expired `fenced_until`):
1. Atomically transitions `pending → dispatched`, sets `dispatch_owner` and a short `fenced_until` (e.g. 30 s).
2. Hands the task to the local `TaskRunner`.
3. `TaskRunner.executeTask` acknowledges receipt by transitioning to `acknowledged_at = now` (still `dispatched`).
4. `markTaskRunningAfterLaunch` transitions `dispatched → completed`.
5. If `fenced_until` expires without acknowledgement, the dispatcher re-issues from `pending`.

Result:
- Issue 0 disappears: the in-memory promise has a durable companion. A dropped promise becomes a `pending` (or stale `dispatched`) row that the dispatcher retries on its next tick.
- Issue 2 disappears: the dispatcher is itself the polled recovery.
- Issue 6 disappears: any TaskRunner (owner or headless) competes for the row atomically; the dispatch lease is the source of truth.
- Issue 9 disappears: watchdog cascades enqueue into the outbox, not into a fire-and-forget promise.
- Issue 5 mitigates: the attempt lease can stay 20 m for `executing` work, but `launching` work no longer needs to occupy a slot for the full lease — the outbox tells the orchestrator when a launch is genuinely in progress versus orphaned.

### Proposal 2 — Wire `relaunchOrphansAndStartReady` into db-poll (cheaper fallback)

If a full outbox is too much surface area, the minimum viable change is:

1. Change the watchdog's recovery action from "mark `failed`" to "call `relaunchOrphansAndStartReady` for orphaned `pending/launching` tasks; mark `failed` only on the Nth consecutive orphan."
2. Reduce the attempt lease for `launching` (e.g. 60 s) and the lease for `executing` separately (keep 20 m).
3. Fix the watchdog error message to substitute `launchAgeMs / 1000`, not the configured timeout.
4. Add a true-invariant regression test: every `task.launch_claimed` must be followed within `2 * launching_lease` seconds by exactly one of `task.executor.selected | task.executor.deferred | task.executor.startup-retry | task.failed (with concrete startup error) | task.prepared_for_new_attempt`.

This is a smaller change but does not address Issues 3, 6, 7, 9, 10, 13, 14. It just stops the steady-state regression from being terminal.

### Cleanups regardless of which proposal is taken

- Single `ATTEMPT_LEASE_MS` source of truth (consolidate into `@invoker/contracts` or `@invoker/workflow-core`) — closes Issue 11.
- Remove the dead `running`/`dequeue` path in `TaskScheduler` and document that capacity is DB-owned — closes Issue 3.
- Fix `repro-rebase-recreate-storm-launch-stall.sh` to assert the inverse condition (closes Issue 15), and add the launch_claimed → executor-event invariant test (Phase 1 of any fix).
- Make every `executeTasks` call either `await` or `void … .catch(...)` — closes the structural mistake at the JS level even if the outbox is the real solution.

## Test Gaps (what we should be checking but aren't)

1. **Invariant: `task.launch_claimed` → terminal launch event within bounded time.** No test asserts this. Add an integration test that drives a launch through `drainScheduler` and asserts the next event for the same attempt is one of `{task.executor.selected, task.executor.deferred, task.executor.startup-retry, task.failed-with-startup-error, task.prepared_for_new_attempt}` — and that it arrives within a bounded time.
2. **Repro: storm with dropped dispatch promise.** Force the fire-and-forget promise to be cancelled mid-flight (e.g. by killing the headless TaskRunner reference before its microtask resolves) and assert the system recovers without operator intervention.
3. **Concurrency starvation under orphan**: assert that N orphaned launches at `maxConcurrency=N` do not block downstream work for more than the launching-lease duration.
4. **Watchdog cascade safety**: assert that a watchdog-induced cascade does not itself produce a second orphan.
5. **Pivot completion**: assert pivot/spawn-experiments parents do not remain in `pending/launching` after `handleWorkerResponse`.
6. **`markTaskRunningAfterLaunch` rejection cleanup**: assert that old-attempt `pending/launching` rows are cleared when the orchestrator rejects a transition.
7. **SSH resource-lease leak**: assert that an exception during executor selection releases any held SSH pool lease.

## Suggested Next Steps

1. **Phase 1 (Reproduce).** Write the failing repro that asserts the `launch_claimed → executor-event` invariant against the current head. Confirm it fails for at least the storm scenario; ideally also for the pivot, double-TaskRunner, and watchdog-cascade vectors.
2. **Decision point.** Choose Proposal 1 (outbox) or Proposal 2 (wire orphan-relaunch + fix lease split). Recommend Proposal 1 because the cumulative cost of point-fixes over the last nine PRs already exceeds the implementation cost of an outbox.
3. **Phase 3 (Plan).** Write a YAML plan with explicit, testable steps:
   - Outbox schema + migration.
   - LaunchDispatcher with atomic claim/ack/expire transitions.
   - Route every `drainScheduler`-issued claim through the outbox.
   - Replace every `executeTasks(started).catch(...)` and fire-and-forget dispatch site with an outbox enqueue.
   - Convert the watchdog from "mark `failed`" to "log a dispatcher exception and rely on retries; fail only after configurable max retries."
   - Fix the existing repro script's inverted condition and add the new invariant test.
   - Cleanups (single `ATTEMPT_LEASE_MS`, scheduler `running` set removal).
4. **Backout safety.** Keep the existing watchdog behind a feature flag during rollout so the old recovery (mark `failed`) is still available if the dispatcher regresses.

## Appendix: Source Citations

Key source locations referenced in this document:

```4870:4988:packages/workflow-core/src/orchestrator.ts
  private drainScheduler(): TaskState[] {
    ...
    claimSucceeded = this.taskRepository.claimAttemptForLaunch?.(attemptId, claimPatch, now) ?? ...;
    ...
    this.persistence.logEvent?.(job.taskId, this.deferRunningUntilLaunch ? 'task.launch_claimed' : 'task.running', changes);
    ...
```

```88:110:packages/app/src/global-topup.ts
  // TODO: replace app-level workflow mutation leases with atomic DB state transitions plus an outbox for launch/cancel side effects.
  const dispatchPromise = mutationTiming
    ? mutationTiming.span(spanName, ..., run)
    : Promise.resolve().then(run);
  void dispatchPromise
    .then(() => bench(afterMark))
    .catch((err) => { logger?.error(...); });
  bench(`${afterMark}.accepted`);
  return Promise.resolve();
```

```41:48:packages/app/src/launch-stall.ts
  const launchStalled =
    phase === 'launching'
    && launchStartedAt !== undefined
    && launchAgeMs >= launchingStallTimeoutMs
    && launchClaimedForCurrentAttempt
    && !launchLeaseActive
    && !hasExecutionHandle
    && !isKnownLaunching;
```

```2581:2611:packages/app/src/main.ts
                    const launchError =
                      `Launch stalled: task remained in running/launching for ${Math.floor(launchingStallTimeoutMs / 1000)}s without a spawned execution handle`;
                    ...
                    void requireTaskExecutor().executeTasks(runnableAfterFailure).catch(...);
```

```87:91:scripts/repro/repro-rebase-recreate-storm-launch-stall.sh
    select count(*)
    from failed_stalls
    where lease_expires_at is not null
      and julianday(lease_expires_at) > julianday(created_at);
```
