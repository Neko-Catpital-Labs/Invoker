# INV-97 Experiment Brief: Deterministic Launch Handoff Proof

Date: 2026-06-21
Status: Proof captured

## Question

When an app-layer mutation makes work runnable again, should the app execute that task in-process immediately, or should it leave execution to the durable launch outbox and dispatcher?

## Files under test

- `packages/app/src/__tests__/app-layer-handoff-repro.test.ts`
- `packages/app/src/global-topup.ts`
- `packages/app/src/headless.ts`
- `packages/app/src/launch-dispatcher.ts`
- `packages/execution-engine/src/task-runner.ts`

## Designs compared

### Selected design: durable launch outbox

The mutation returns runnable tasks, but app-layer refill code does not call `TaskRunner.executeTasks(runnable)` directly. `dispatchStartedTasksWithGlobalTopup` filters runnable/top-up work from already-started scheduler results and leaves the actual handoff to `LaunchDispatcher`. The dispatcher leases `task_launch_dispatch` rows, verifies the current attempt/generation, and calls `TaskRunner.executeTask(task, { dispatchId, launchOutbox })`. `TaskRunner` then terminates the dispatch row with `completeDispatch` or `failDispatch`.

Evidence anchors:

- `packages/app/src/global-topup.ts:92` documents that the durable launch outbox owns dispatch.
- `packages/app/src/global-topup.ts:202` filters scoped runnable work and top-up work without directly launching the batch.
- `packages/app/src/headless.ts:274` builds a local `LaunchDispatcher` for headless mutation returns.
- `packages/app/src/headless.ts:2345`, `:2377`, `:2419`, and `:2455` route edit command, prompt, executor, and agent mutations through `dispatchHeadlessRunnableTasks`.
- `packages/app/src/launch-dispatcher.ts:132` atomically claims a dispatch row.
- `packages/app/src/launch-dispatcher.ts:175` hands the leased row to `TaskRunner.executeTask` with outbox ack hooks.
- `packages/execution-engine/src/task-runner.ts:611`, `:636`, `:734`, and `:1299` complete or fail the dispatch row from runner outcomes.

### Competing design: immediate in-process execution

The competing design is to call `TaskRunner.executeTasks(runnable)` from app-layer mutation refill code. It has lower ceremony, but it creates an in-memory ownership boundary: if the promise is dropped, the process exits, or a second `TaskRunner` instance does not share launch state, the durable task state can say runnable/running while no durable owner is responsible for the launch. This is exactly the class of issue described in the launch handoff architecture notes and guarded by this repro.

The selected design is preferred because the handoff has a durable row, a poller, stale-attempt checks, and terminal ack/fail paths. The direct design is only acceptable for legacy paths not covered by this proof or for code that does not cross the app-layer mutation handoff boundary.

## Deterministic commands

Run from the repository root unless a command explicitly changes directory.

### 1. Repro test

```sh
cd packages/app
pnpm exec vitest run src/__tests__/app-layer-handoff-repro.test.ts
```

Expected output threshold:

- Exit code: `0`
- `Test Files  1 passed (1)`
- `Tests  7 passed (7)`
- The seven test names include:
  - `edit-task-command records a runnable launch for the outbox`
  - `edit-task-prompt records a runnable launch for the outbox`
  - `edit-task-agent records a runnable launch for the outbox`
  - `set-task-external-gate-policies records the newly unblocked task for the outbox`
  - `replace-task records replacement launches for the outbox`
  - `set-merge-branch leaves merge relaunch for the outbox`
  - `standalone-owner set-merge-branch leaves merge relaunch for the outbox`

Observed on 2026-06-21:

```text
✓ src/__tests__/app-layer-handoff-repro.test.ts (7 tests) 104ms

Test Files  1 passed (1)
     Tests  7 passed (7)
```

Verdict: pass. The repro covers command, prompt, agent, external gate, replacement, merge branch retry, and standalone-owner merge branch retry handoffs.

### 2. Static guard: global top-up does not directly execute runnable batches

```sh
rg -n "^\\s*(await|void)?\\s*taskExecutor\\.executeTasks\\(" packages/app/src/global-topup.ts || true
```

Expected output threshold:

- Exit code: `0`
- Output: empty

Observed on 2026-06-21: empty output.

Verdict: pass. `global-topup.ts` keeps the app-layer refill boundary outbox-owned instead of directly executing the runnable batch.

### 3. Static guard: tested headless edit paths enter the dispatcher helper

```sh
rg -n "await dispatchHeadlessRunnableTasks\\(deps, taskExecutor, runnable, '(edit-task-command|edit-task-prompt|edit-task-type|edit-task-agent)'\\)" packages/app/src/headless.ts
```

Expected output threshold:

- Exit code: `0`
- Exactly four matching lines, one each for `edit-task-command`, `edit-task-prompt`, `edit-task-type`, and `edit-task-agent`.

Observed on 2026-06-21:

```text
2345:  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-command');
2377:  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-prompt');
2419:  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-type');
2455:  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-agent');
```

Verdict: pass. The app-layer mutation paths exercised by the repro use the dispatcher helper.

### 4. Static guard: dispatcher-to-runner handoff has durable ack/fail hooks

```sh
rg -n "executeTask\\(task, \\{ dispatchId: leased\\.id, launchOutbox: this \\}\\)|completeDispatch\\(dispatchOpts\\.dispatchId\\)|failDispatch\\(dispatchOpts\\.dispatchId" packages/app/src/launch-dispatcher.ts packages/execution-engine/src/task-runner.ts
```

Expected output threshold:

- Exit code: `0`
- At least one `executeTask(... dispatchId ... launchOutbox ...)` match in `launch-dispatcher.ts`.
- At least one `completeDispatch(...)` match and one `failDispatch(...)` match in `task-runner.ts`.

Observed on 2026-06-21:

```text
packages/app/src/launch-dispatcher.ts:175:        .executeTask(task, { dispatchId: leased.id, launchOutbox: this })
packages/execution-engine/src/task-runner.ts:611:          const completed = dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
packages/execution-engine/src/task-runner.ts:636:        dispatchOpts.launchOutbox.failDispatch(dispatchOpts.dispatchId, err);
packages/execution-engine/src/task-runner.ts:734:          dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
packages/execution-engine/src/task-runner.ts:1299:      dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
```

Verdict: pass. The selected design has a durable dispatch row at handoff and terminal runner callbacks for completion/failure.

## Acceptance thresholds

INV-97 proof is accepted only if all thresholds hold:

- The focused repro test exits `0` with exactly one test file and seven tests passing.
- `global-topup.ts` has no direct runnable-batch `taskExecutor.executeTasks(...)` call.
- The tested app/headless mutation paths route through `dispatchHeadlessRunnableTasks`.
- `LaunchDispatcher` calls `TaskRunner.executeTask` with `dispatchId` and `launchOutbox`.
- `TaskRunner` has both outbox completion and failure paths.

## Final verdict

The selected durable launch-outbox design is better supported than immediate in-process execution for the INV-97 app-layer handoff. The test demonstrates the observable contract: mutation paths return runnable work for the outbox, do not pre-assign a fresh workspace for normal task relaunches, preserve merge retry workspace metadata, and avoid unintended global top-up. The static guards tie that behavior to the architecture: app refill avoids direct execution, headless edit paths poll a local dispatcher, the dispatcher owns the lease, and the runner terminates the dispatch row.
