# INV-113 Experiment Brief: Deterministic TaskRunner Execution Proof

Date: 2026-05-18

## Scope

This proof covers the execution architecture in:

- `packages/execution-engine/src/task-runner.ts`
- `packages/execution-engine/src/__tests__/task-runner.test.ts`

The selected architecture is attempt-scoped execution control: launches, active execution handles, stale startup failure handling, and cancellation are keyed by attempt identity and guarded by execution generation. The competing design considered is task-id-only execution control, where a task has at most one live execution record regardless of selected attempt or generation.

## Architecture Under Test

Selected design:

- In-flight launches are tracked by attempt id, not task id: `activeExecutions` and `launchingAttemptIds` are keyed by attempt identity in `task-runner.ts` lines 222-224.
- `executeTask` resolves an attempt id before launch, suppresses duplicate launches for the same attempt, and cleans up the launch guard in `finally`: `task-runner.ts` lines 412-455.
- `killActiveExecution` resolves the current selected attempt before killing, so stale attempts are not killed when a newer selected attempt exists without a live handle: `task-runner.ts` lines 307-353.
- Startup-failure metadata and failed responses are suppressed when `selectedAttemptId` or generation has advanced: `task-runner.ts` lines 395-409 and 447-455.
- Work requests carry `attemptId`, `executionGeneration`, `freshWorkspace`, `reusableWorktree`, upstream branches, and alternatives: `task-runner.ts` lines 644-676.
- Branch metadata is guarded before downstream execution to prevent silently dropping upstream work: `task-runner.ts` lines 573-597.
- Executor selection can be pool-aware without changing the attempt-scoped execution model: `task-runner.ts` lines 972-1100.

## Competing Design

Alternative: task-id-only execution tracking.

Expected advantages:

- Simpler maps and cancellation lookup.
- Fewer persisted identifiers in executor callbacks.

Rejected because:

- Concurrent old/new attempts for the same task become ambiguous; cancellation can kill the wrong process.
- Startup failures from superseded launches can overwrite branch/workspace metadata for the live attempt.
- Recreate flows need to distinguish fresh workspaces from restart/reuse flows; task id alone does not encode lineage.

The deterministic tests exercise these failure modes directly:

- `task-runner.test.ts` lines 244-302: duplicate launch suppression is per attempt.
- `task-runner.test.ts` lines 369-454: cancellation kills the selected attempt when an older attempt is still active.
- `task-runner.test.ts` lines 456-518: cancellation does not kill an older active attempt when the selected attempt has no live execution.
- `task-runner.test.ts` lines 520-701: recreate-style launches require fresh workspaces while restart-style launches remain reusable.
- `task-runner.test.ts` lines 1134-1350: stale startup failure metadata and failed responses are suppressed when lineage has advanced.
- `task-runner.test.ts` lines 1353-1506: missing branch metadata fails closed, while valid external dependency branches flow into `WorkRequest.inputs.upstreamBranches`.

## Deterministic Commands

Run from the repository root:

```bash
cd packages/execution-engine
pnpm exec vitest run src/__tests__/task-runner.test.ts
```

Expected output threshold:

- Exit code: `0`
- Test files: `1 passed (1)`
- Tests: `129 passed (129)`
- Failure threshold: `0` failed tests

Observed output on 2026-05-18:

```text
✓ src/__tests__/task-runner.test.ts (129 tests) 1400ms

Test Files  1 passed (1)
     Tests  129 passed (129)
  Duration  2.71s
```

Broader package verification was also run accidentally through the package script and completed successfully:

```bash
pnpm --filter @invoker/execution-engine test -- --run packages/execution-engine/src/__tests__/task-runner.test.ts
```

Observed output threshold:

- Exit code: `0`
- Test files: `47 passed (47)`
- Tests: `963 passed (963)`

## Verdicts

Selected approach: pass.

Evidence:

- Attempt/generation metadata survives the request/response path (`task-runner.test.ts` lines 115-184).
- Duplicate launches are suppressed only for the same attempt (`task-runner.test.ts` lines 244-302).
- Cancellation resolves the selected attempt and avoids stale-attempt termination (`task-runner.test.ts` lines 369-518).
- Recreate and restart semantics produce deterministic `freshWorkspace` values (`task-runner.test.ts` lines 520-701).
- Stale startup failures do not persist old workspace/branch/session metadata or emit failed responses (`task-runner.test.ts` lines 1134-1350).
- Missing branch metadata fails closed before downstream work can run without upstream changes (`task-runner.test.ts` lines 1353-1506).

Competing task-id-only approach: fail.

Reason: it cannot satisfy the selected-attempt cancellation and stale-lineage suppression tests without reintroducing attempt identity or generation checks, which collapses it back into the selected design.

## Review Thresholds

The architecture remains accepted while all of these hold:

- The scoped command exits `0`.
- `src/__tests__/task-runner.test.ts` reports at least `129` passing tests and `0` failures.
- Test coverage continues to include selected-attempt cancellation, stale startup failure suppression, fresh workspace semantics, and branch metadata fail-closed behavior.
- Any future executor-pool changes preserve attempt-scoped `activeExecutions` and do not key cancellation solely by task id.
