# INV-97 Experiment Brief: App-Layer Handoff Dispatch

## Goal

Establish deterministic proof that app-layer workflow mutations hand runnable tasks to the shared execution path, so restarted or newly unblocked work persists executor metadata such as `workspacePath`.

## Files Under Test

- `packages/app/src/__tests__/app-layer-handoff-repro.test.ts`
- `packages/app/src/global-topup.ts`
- `packages/app/src/headless.ts`
- `packages/execution-engine/src/task-runner.ts`
- `packages/test-kit/src/test-harness.ts`

## Selected Architecture

Use the app-layer dispatch helper, `dispatchStartedTasksWithGlobalTopup`, after mutations that return `started` tasks.

Evidence points:

- The repro test calls orchestrator mutations, confirms the returned tasks are `running`, then dispatches them through `dispatchStartedTasksWithGlobalTopup`.
- `dispatchStartedTasksWithGlobalTopup` filters `started` tasks through `isDispatchableLaunch`, executes the scoped set first, and then runs global top-up without double-dispatching the scoped work.
- `TaskRunner.executeTasks` launches each runnable task through the executor pipeline.
- `TaskRunner.executeTaskInner` requires the executor handle to include `workspacePath` and persists it immediately to the task row and attempt row.
- `headless.ts` already uses the same helper for several mutation surfaces, including retry, fix-with-agent, resolve-conflict, rebase-and-retry, recreate-with-rebase, and facade-backed mutation paths.

## Competing Design

Alternative: let each headless command or UI mutation handler call `taskExecutor.executeTasks(started.filter(...))` directly.

Verdict: rejected.

Reasons:

- It duplicates filtering and launch sequencing across mutation handlers.
- It does not encode the global top-up behavior in one reviewable place.
- It is easier for one mutation surface to forget dispatch after an orchestrator mutation returns `started`, recreating the missing-`workspacePath` failure mode.
- Existing repro coverage exercises the shared helper directly, so the selected design has a smaller testable surface.

## Deterministic Command

Run from the repository root:

```sh
pnpm --dir packages/app exec vitest run src/__tests__/app-layer-handoff-repro.test.ts
```

## Expected Output

The command must exit with status `0` and include:

```text
✓ src/__tests__/app-layer-handoff-repro.test.ts (8 tests)

Test Files  1 passed (1)
     Tests  8 passed (8)
```

Observed on 2026-05-16:

```text
✓ src/__tests__/app-layer-handoff-repro.test.ts (8 tests) 203ms

Test Files  1 passed (1)
     Tests  8 passed (8)
Duration  2.58s
```

## Thresholds

- Pass threshold: `1` test file passed, `8` tests passed, `0` failures, process exit status `0`.
- Handoff threshold: each mutation repro must assert that the mutation starts a `running` task before dispatch and that dispatch persists `workspacePath`.
- Workspace threshold: non-merge task repros must persist `/tmp/mock-worktree`; merge task repros must preserve `/tmp/mock-merge-worktree`.
- Regression threshold: any missing `workspacePath`, non-`completed` restarted task, or failed focused test is a blocking regression for INV-97.

## Verdict

Selected design is supported.

The focused repro proves the intended boundary: orchestrator mutations return runnable tasks, the app-layer helper dispatches those tasks, and `TaskRunner` persists executor workspace metadata. The competing direct-dispatch design is less reviewable because it spreads the same handoff logic across callers instead of centralizing the invariant.
