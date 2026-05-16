# INV-113 Experiment Brief: Deterministic TaskRunner Evidence

## Scope

This experiment proves that the selected TaskRunner execution architecture is deterministic enough to review and defend for INV-113. The files under test are:

- `packages/execution-engine/src/task-runner.ts`
- `packages/execution-engine/src/__tests__/task-runner.test.ts`

## Selected Design

Use attempt-scoped execution identity in `TaskRunner`, with `attemptId` as the key for launch de-duplication, active execution tracking, kill routing, WorkRequest provenance, completion normalization, heartbeat persistence, and startup failure reporting.

Concrete implementation points:

- `activeExecutions` and `launchingAttemptIds` are keyed by attempt identity, not only task identity (`task-runner.ts:201`).
- `executeTask` resolves the launch attempt before executor startup and skips duplicate launches for the same attempt (`task-runner.ts:389`).
- `WorkRequest` carries both `attemptId` and `executionGeneration`, and executor-facing inputs carry `freshWorkspace` (`task-runner.ts:621`).
- Startup failure responses include the same attempt identity and generation used for launch (`task-runner.ts:462`).
- Successful starts persist workspace and branch metadata to both task and attempt records (`task-runner.ts:778`).
- Completion responses are normalized to the launch attempt before orchestrator mutation (`task-runner.ts:865`).
- Fresh workspace reuse is determined by generation plus cleared branch/workspace metadata (`task-runner.ts:918`).
- Upstream branch collection is deterministic: completed dependency branches are collected in dependency order, de-duplicated, and fan-in prepends the workflow base branch when needed (`task-runner.ts:2146`).

## Competing Design Considered

Alternative: task-scoped execution tracking, where active executions are keyed only by `task.id`, and retry/recreate/restart behavior is inferred from current task status.

Verdict: reject.

Reasoning:

- A task can have multiple semantic generations and attempts over its lifecycle. A task-only key cannot distinguish stale startup failures from the current attempt.
- Concurrent calls to `executeTask` for the same selected attempt must collapse to one executor launch, but a later selected attempt must be allowed to launch as distinct work. Attempt-scoped keys express both requirements directly.
- Kill routing must target the currently active attempt handle. Attempt metadata on the handle makes this reviewable in tests.
- Recreate flows need a deterministic fresh-workspace signal; task status alone cannot distinguish a restart that should reuse branch/workspace state from a recreate that intentionally cleared both.

## Deterministic Commands

Run from the repository root unless noted.

### Focused TaskRunner Proof

Command:

```bash
cd packages/execution-engine
pnpm exec vitest run src/__tests__/task-runner.test.ts
```

Expected output thresholds:

- Exit code: `0`
- Test file summary contains: `src/__tests__/task-runner.test.ts (203 tests)`
- Final summary contains: `Test Files  1 passed (1)`
- Final summary contains: `Tests  203 passed (203)`

Observed output on 2026-05-16 UTC:

```text
PASS src/__tests__/task-runner.test.ts (203 tests) 4083ms
Test Files  1 passed (1)
Tests  203 passed (203)
Duration  8.16s
```

Note: Vitest also emitted a package export condition warning about the `types` condition order in `packages/execution-engine/package.json`. It did not affect the pass/fail verdict.

### Guardrail: Avoid Broad Invocation

Do not use:

```bash
pnpm --filter @invoker/execution-engine test -- --runInBand packages/execution-engine/src/__tests__/task-runner.test.ts
```

That command forwards arguments through the package script in a way that runs broader package tests instead of the focused TaskRunner proof. In this workspace it was terminated after unrelated suites began running. It is not the deterministic INV-113 proof command.

## Proof Cases And Verdicts

### Attempt Identity Is Preserved

Evidence:

- Test: `sends attemptId and executionGeneration in work requests and preserves them in responses` (`task-runner.test.ts:115`).
- It launches a task with `selectedAttemptId: gen-task-a1` and `generation: 7`.
- It asserts the outbound request contains `attemptId: gen-task-a1` and `executionGeneration: 7`.
- It asserts `handleWorkerResponse` receives the same attempt and generation.

Verdict: pass. Attempt identity and generation are stable across request and completion.

### Startup Failure Still Dispatches Ready Work

Evidence:

- Test: `dispatches newly ready tasks after executor startup failure` (`task-runner.test.ts:186`).
- The mocked Docker executor throws before returning a handle.
- `handleWorkerResponse` receives a failed response for `docker-no-image`.
- `executeTasks` is called with the newly ready task returned by the orchestrator.

Verdict: pass. A startup failure is deterministic task output, not a scheduler dead end.

### Concurrent Same-Attempt Launches Are De-Duplicated

Evidence:

- Test: `deduplicates concurrent launches for the same attempt` (`task-runner.test.ts:244`).
- Two concurrent `executeTask(task)` calls use `selectedAttemptId: dup-task-a1`.
- The executor `start` mock is asserted to run exactly once before and after completion.

Verdict: pass. The selected approach prevents duplicate executor processes for the same attempt.

### Kill Routing Uses The Active Attempt

Evidence:

- Test: `kills the active execution for a task by resolving its current attempt` (`task-runner.test.ts:304`).
- `killActiveExecution(task.id)` resolves the selected attempt and passes a handle containing `attemptId: kill-task-a1` to the executor.

Verdict: pass. Cancellation targets the active execution handle, not an ambiguous task-level placeholder.

### Recreate Gets Fresh Workspace, Restart Reuses State

Evidence:

- Test: `marks recreateTask-style executions as requiring a fresh workspace` (`task-runner.test.ts:369`) expects `freshWorkspace` to be `true` when generation is incremented and branch/workspace are cleared.
- Test: `marks recreateWorkflow-style root task executions as requiring a fresh workspace` (`task-runner.test.ts:430`) proves the same behavior for workflow-root recreation.
- Test: `keeps restart-style executions reusable when branch or workspace state is still present` (`task-runner.test.ts:491`) expects `freshWorkspace` to be `false` when existing branch/workspace state remains.
- Implementation: `shouldUseFreshWorkspace` requires generation greater than zero plus missing branch and workspace (`task-runner.ts:918`).

Verdict: pass. Recreate and restart have deterministic, reviewable executor-facing signals.

### Upstream Branch Collection Is Stable

Evidence:

- Implementation: `collectUpstreamBranches` walks local dependencies first, then external dependencies, records only completed branches, de-duplicates, and prepends plan base for fan-in (`task-runner.ts:2146`).
- Tests under `collectUpstreamBranches` begin at `task-runner.test.ts:582` and cover completed dependencies, missing branch exclusion, non-completed exclusion, reconciliation winner branch propagation, diamond ordering, fan-out, fan-in base prepending, and external dependencies.

Verdict: pass. Downstream branch inputs are deterministic and tied to completed dependency metadata.

## Review Thresholds

The selected design remains accepted only if all thresholds hold:

- Focused command exits `0`.
- All `203` tests in `src/__tests__/task-runner.test.ts` pass.
- Same-attempt concurrent launch starts exactly one executor process.
- WorkRequest and completion response preserve selected attempt ID and generation.
- Startup failure creates a failed response and executes newly ready follow-up tasks.
- Recreate signals `freshWorkspace: true`; restart with retained branch/workspace signals `freshWorkspace: false`.
- Completed dependency branch collection remains stable in dependency order, with fan-in base prepending.

Any regression against these thresholds rejects the architecture until the implementation and proof are updated together.
