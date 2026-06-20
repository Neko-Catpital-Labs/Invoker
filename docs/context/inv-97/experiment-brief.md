# INV-97 Experiment Brief: Deterministic App-Layer Launch Handoff

Date: 2026-06-20

## Decision Under Test

Selected design: app-layer workflow mutations must record runnable work for the durable launch outbox and return without directly executing the task. The scheduler/top-up helper may identify runnable tasks, but the launch dispatcher owns the handoff to `TaskRunner.executeTask(...)`.

Concrete files under test:

- `packages/app/src/__tests__/app-layer-handoff-repro.test.ts`
- `packages/app/src/global-topup.ts`
- `packages/app/src/headless.ts`
- `packages/execution-engine/src/task-runner.ts`

## Competing Designs

Selected: durable launch-outbox handoff.

- `packages/app/src/global-topup.ts:1` documents the invariant: ready tasks are claimed into `task_launch_dispatch`, and the `LaunchDispatcher` owns the actual `TaskRunner.executeTask(...)` handoff.
- `packages/app/src/global-topup.ts:76` implements `dispatchTasks(...)` as an outbox-only boundary. It records scheduler-bench marks and intentionally skips in-process `taskExecutor.executeTasks(runnable)`.
- `packages/app/src/headless.ts:273` bridges headless mutations by creating a local `LaunchDispatcher`, polling immediately, and polling every 250ms for runnable rows.
- `packages/execution-engine/src/task-runner.ts:240` defines the narrow `LaunchOutboxAck` interface so the execution engine can acknowledge rows without importing the app layer.
- `packages/execution-engine/src/task-runner.ts:517` prevents recursive direct execution when a launch is already owned by a dispatch row.
- `packages/execution-engine/src/task-runner.ts:1284` completes the dispatch row after executor startup metadata has been persisted.

Alternative rejected: direct post-mutation execution.

- In this design `dispatchStartedTasksWithGlobalTopup(...)` would call `taskExecutor.executeTasks(runnable)` directly after each mutation.
- It is simpler locally, but it reintroduces two launch owners: the caller's transient `TaskRunner` and the durable outbox dispatcher. That competes with the per-runner `launchingAttemptIds` duplicate guard in `packages/execution-engine/src/task-runner.ts:576`, because duplicate suppression is process-local while the launch row is durable.
- It also makes headless commands sensitive to whether they reuse the owner runner. `packages/app/src/headless.ts:117` describes the long-lived owner runner path that avoids multi-runner blindness; direct execution from ad hoc mutation callers would bypass that architectural boundary.

Verdict: keep the durable launch-outbox handoff. It is the only option that gives one durable launch owner across CLI, GUI, and standalone-owner mutation paths.

## Deterministic Proof Command

Run from repo root:

```bash
pnpm --filter @invoker/app exec vitest run src/__tests__/app-layer-handoff-repro.test.ts
```

Expected summary:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

Observed on 2026-06-20:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
Duration    774ms
```

## Assertions Covered

The repro file checks eight deterministic mutation paths:

- `edit-task-command`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:47`
- `edit-task-prompt`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:63`
- `edit-task-type`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:90`
- `edit-task-agent`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:106`
- `set-task-external-gate-policies`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:122`
- `replace-task`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:168`
- `set-merge-branch`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:189`
- `standalone-owner set-merge-branch`: `packages/app/src/__tests__/app-layer-handoff-repro.test.ts:214`

Each path applies the same threshold:

- The mutation result must include exactly the expected runnable task.
- `dispatchStartedTasksWithGlobalTopup(...)` must return that task in `runnable`.
- `topup` must be empty for the scoped repro.
- The task must remain `running`.
- For non-merge relaunches, `workspacePath` must remain `undefined`, proving the app-layer helper did not start an executor.
- For merge relaunches, the existing `/tmp/mock-merge-worktree` metadata must be preserved while the task remains `running`, proving the relaunch was recorded without replacing merge workspace provenance.

## Failure Thresholds

This experiment fails if any of the following happens:

- The focused command exits non-zero.
- The focused command reports anything other than `1 passed` test file and `8 passed` tests.
- Any tested mutation returns no runnable task, more than one runnable task, or the wrong task id.
- `dispatchStartedTasksWithGlobalTopup(...)` starts executor work directly, which would surface as unexpected `workspacePath` population for non-merge relaunches.
- A merge relaunch loses `/tmp/mock-merge-worktree` after `dispatchStartedTasksWithGlobalTopup(...)`.

## Non-Goal Observation

An accidental broader command, `pnpm --filter @invoker/app test -- app-layer-handoff-repro.test.ts`, invoked the app package script and discovered the full app suite. The INV-97 repro still passed inside that run, but the full suite exited non-zero due to unrelated `src/__tests__/cli-installer.test.ts` expectations that resolved `/opt/homebrew/bin/invoker-cli` instead of the temporary test install directory. That is not evidence against INV-97 because the deterministic proof command above isolates the file under test.
