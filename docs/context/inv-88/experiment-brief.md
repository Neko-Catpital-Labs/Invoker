# INV-88 Experiment Brief: Deterministic Orchestrator Proof

## Scope

INV-88 needs reviewable evidence for the workflow-core orchestration design. This brief pins the proof to concrete code and deterministic test commands for:

- `packages/workflow-core/src/orchestrator.ts`
- `packages/workflow-core/src/__tests__/orchestrator.test.ts`

## Architecture Under Test

Selected approach: DB-first orchestrator mutations with a read-only in-memory graph cache.

Evidence in `orchestrator.ts`:

- Test determinism is explicit: `nextWorkflowId()` returns `wf-test-N` under `NODE_ENV=test`, and `workflowTimestamp()` honors `INVOKER_TEST_FIXED_NOW` (`orchestrator.ts:99`, `orchestrator.ts:105`).
- Public mutations refresh state from persistence before computing against the graph cache (`refreshFromDb`, `orchestrator.ts:822`).
- Mutations persist through `taskRepository.updateTask()` before refreshing the in-memory task snapshot returned to callers (`writeAndSync`, `orchestrator.ts:845`).
- `loadPlan()` scopes runtime task IDs, validates before side effects, saves workflow/task state, publishes created deltas, then reconciles merge leaves (`orchestrator.ts:1361`, `orchestrator.ts:1498`, `orchestrator.ts:1538`).
- Experiment spawning creates scoped variant tasks plus a reconciliation node, then routes graph mutation through the shared structural mutation primitive (`orchestrator.ts:4394`, `orchestrator.ts:4418`, `orchestrator.ts:4443`).
- Experiment selection completes the reconciliation node with the selected winner and uses downstream invalidation for reselection (`orchestrator.ts:2046`, `orchestrator.ts:2068`, `orchestrator.ts:2080`).

Competing approach considered: in-memory-first orchestration with asynchronous persistence.

Verdict: rejected for INV-88. It would make UI-visible task state depend on cache write ordering and delayed DB sync, which weakens restart/replay evidence. The existing tests intentionally corrupt persisted merge state and require `syncAllFromDb()` to throw without repairing the DB row, proving the DB remains the reviewed source of truth.

## Deterministic Commands

Run from the repository root.

### Command 1: broad orchestrator topology and unblocking proof

```sh
NODE_ENV=test INVOKER_TEST_FIXED_NOW=2026-01-02T03:04:05.000Z pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/orchestrator.test.ts -t "loadPlan|merge gate leaf reconciliation|blocked task unblocking"
```

Expected output summary:

```text
✓ src/__tests__/orchestrator.test.ts (349 tests | 288 skipped)
Test Files  1 passed (1)
Tests  61 passed | 288 skipped (349)
```

Thresholds:

- Required: 1 test file passed.
- Required: 61 tests passed.
- Required: 0 failed tests.
- Allowed: esbuild package export warning about the `types` condition ordering.
- Allowed: timing differences in `Start at` and `Duration`.

Verdict: pass on this checkout.

### Command 2: focused experiment and invariant proof

```sh
NODE_ENV=test INVOKER_TEST_FIXED_NOW=2026-01-02T03:04:05.000Z pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/orchestrator.test.ts -t "passes experimentVariants|experiment spawn: merge gate deps include reconciliation node|experiment spawn with downstream: merge gate deps point to remapped downstream|throws when a persisted merge node has detached dependencies|throws when a persisted merge experiment is detached from its parent merge node"
```

Expected output summary:

```text
✓ src/__tests__/orchestrator.test.ts (349 tests | 344 skipped)
Test Files  1 passed (1)
Tests  5 passed | 344 skipped (349)
```

Thresholds:

- Required: 1 test file passed.
- Required: 5 tests passed.
- Required: 0 failed tests.
- Allowed: esbuild package export warning about the `types` condition ordering.
- Allowed: timing differences in `Start at` and `Duration`.

Verdict: pass on this checkout.

## Concrete Test Evidence

The focused command proves these review points:

- Plan-defined experiment variants are persisted onto task config (`orchestrator.test.ts:875`).
- Merge nodes depend on leaf tasks and every task is persisted (`orchestrator.test.ts:936`, `orchestrator.test.ts:955`).
- When a pivot spawns experiments, the merge gate depends on the reconciliation node if it is the workflow leaf (`orchestrator.test.ts:8379`).
- When the pivot has downstream work, merge gate dependencies remap to that downstream task while the downstream depends on the reconciliation node (`orchestrator.test.ts:8408`).
- Persisted detached merge dependencies fail invariant checks without silently repairing the DB row (`orchestrator.test.ts:9461`).
- Persisted detached merge experiment nodes fail invariant checks (`orchestrator.test.ts:9485`).

## Review Verdict

The selected DB-first orchestrator with scoped deterministic test IDs is evidence-backed for INV-88. The test thresholds above are narrow enough to catch topology, persistence, experiment spawning, reconciliation, and merge invariant regressions while remaining deterministic under fixed test environment variables.
