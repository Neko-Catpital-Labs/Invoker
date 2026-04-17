# Launching-stall dispatch-gap repro

Repros the bug observed in production where tasks got stuck on
`launch_phase=launching` for 600 seconds before the `db-poll`
launch-stall watchdog forcibly failed them.

Concrete instance from `~/.invoker/invoker.log`:

```
time="2026-04-16T21:23:10.409Z"  level=error  module=db-poll
msg=[launch-stall] forcing failure for "wf-1775874004544-6/add-prompt-edit-tests":
    Launch stalled: task remained in running/launching for 600s
    without a spawned execution handle
```

## Root cause (claim)

In `packages/app/src/main.ts` there is only **one** mechanism that marks a
task `status=running, launch_phase=launching`:

```
packages/workflow-core/src/orchestrator.ts:3116-3138   // drainScheduler
```

Every consumer of `drainScheduler`'s return (`restartTask`, `retryWorkflow`,
`recreateTask`, `recreateWorkflow`, `startExecution`, `resumeWorkflow`, the
GUI `invoker:start` handler, the `relaunchOrphansAndStartReady` helper,
etc.) is expected to pass those tasks to `TaskRunner.executeTasks(...)` so
that `executor.start()` actually runs. If any one of those callers forgets
to dispatch, or dispatches to a runner that silently drops the task, the
task is left in `running/launching` with a `claimed` attempt and no
active process. Nothing in the runtime clears that state except the
launch-stall watchdog in `main.ts`:

```
packages/app/src/main.ts:1952-1976   // launch-stall watchdog
```

The watchdog fires once `now - launch_started_at >= INVOKER_LAUNCHING_STALL_TIMEOUT_MS`
(default `600_000`) and posts a synthetic failed `WorkResponse` through
`orchestrator.handleWorkerResponse(...)` — whose return value is then
**discarded** on line 1975 of `main.ts`, which is itself a second-order
dispatch gap.

## What `repro.sh` proves

`repro.sh`:

1. Makes an isolated `INVOKER_DB_DIR` under `/tmp/`.
2. Copies the prod DB **schema only** (no rows) into a fresh SQLite file.
3. Inserts one workflow, one task, and one `claimed` attempt such that the
   task sits in the exact stuck state (`status=running`,
   `launch_phase=launching`, `launch_started_at` = 5s ago) without any
   runner having been invoked.
4. Starts the real Invoker Electron app against that DB with:
   - `disableAutoRunOnStartup=true` — disables the orphan-relaunch code in
     `relaunchOrphansAndStartReady`, so the watchdog is the **only** code
     path that can move the task out of `launching`.
   - `INVOKER_LAUNCHING_STALL_TIMEOUT_MS=5000` — 5-second watchdog instead
     of the default 10 minutes.
5. Polls the DB every 500 ms and reports:
   - Whether the task transitioned to `failed`.
   - Whether the `error` column matches the expected regex
     `^Launch stalled: task remained in running/launching for \d+s without
     a spawned execution handle$`.
   - Whether a matching `[launch-stall] forcing failure for "<taskId>"`
     line appeared in `~/.invoker/invoker.log` (module=`db-poll`),
     attributing authorship to the watchdog.

The script exits 0 iff all three match.

## Running

```bash
# From the repro worktree, or anywhere — paths are absolute.
bash /tmp/invoker-repros/launching-stall/scripts/repro-launching-stall/repro.sh
# Keep artifacts for inspection:
KEEP_REPRO_HOME=1 bash .../repro.sh
```

Typical runtime: ~13 s (Electron boot + 5 s watchdog window + flush).

## Follow-ups suggested by this repro

To truly fix the bug (not just shorten the watchdog), we need to either:

1. Make `drainScheduler` refuse to mark a task `launching` unless a
   dispatch is guaranteed (e.g., take a dispatch callback as argument and
   only flip state after the callback has handed the task to the runner),
   or
2. Audit every caller of `autoStartReadyTasks` / `drainScheduler` to
   confirm it passes the return value to `TaskRunner.executeTasks(...)`.
   In particular:
   - `packages/app/src/main.ts:1975` — `orchestrator.handleWorkerResponse(
     failedResponse)` inside the watchdog itself discards the return,
     which can cascade the stall into any newly-unblocked tasks.
   - `packages/app/src/main.ts:2272` — the `invoker:stop` handler also
     discards the return of `handleWorkerResponse`.
3. Shorten / make adaptive `INVOKER_LAUNCHING_STALL_TIMEOUT_MS`, since
   600 s is a long floor for what is effectively a dispatch bug.
