# INV-90 Experiment Brief: Deterministic Invalidation Policy Proof

## Goal

Establish deterministic proof that workflow invalidation is governed by reviewable policy data plus a single routing path, and that the orchestrator primitives preserve the hard invariants under test.

## Files Under Test

- `packages/workflow-core/src/invalidation-policy.ts`
  - `MUTATION_POLICIES` freezes mutation-to-action decisions at lines 45-77.
  - `applyInvalidation` validates scope/action pairs, runs `cancelInFlight` before retry/recreate/fork actions, and explicitly skips cancellation for `scheduleOnly` at lines 128-231.
- `packages/workflow-core/src/orchestrator.ts`
  - `cancelActiveBeforeInvalidation` provides defense-in-depth cancellation for direct orchestrator callers at lines 1028-1106.
  - `retryTask`, `retryWorkflow`, `recreateTask`, and `recreateWorkflow` call the defense-in-depth cancellation path before reset logic at lines 2216-2617.
  - `recreateWorkflowFromFreshBase` records the fresh-base semantic before delegating to `recreateWorkflow` at lines 2619-2688.
- `packages/workflow-core/src/__tests__/orchestrator.test.ts`
  - Fresh-base recreate semantics and routing assertions are at lines 6520-6715.
  - Merge-mode invalidation assertions are at lines 7533-7657.
  - Fix-context invalidation assertions are at lines 7914-8058.
- `packages/workflow-core/src/__tests__/invalidation-policy.test.ts`
  - Policy-table mapping and immutability assertions are at lines 31-92.
  - Router cancel-first and scope validation assertions are at lines 116-305.
  - `scheduleOnly` non-cancelling behavior is asserted at lines 316-360.

## Selected Approach

Use a frozen policy table plus one router:

1. `MUTATION_POLICIES` is the reviewable source of truth for mutation classification.
2. `applyInvalidation` is the single async route for scope validation, cancel-first ordering, and lifecycle dispatch.
3. Orchestrator lifecycle primitives keep direct-call safety by invoking `cancelActiveBeforeInvalidation` before reset.
4. Fresh-base workflow invalidation is a first-class lifecycle action, `recreateWorkflowFromFreshBase`, rather than hidden inside app-layer rebase code.

This approach is selected because it makes architectural decisions diffable and testable. Every mutation class has one table entry, one expected action, and deterministic tests that fail if the route changes.

## Competing Design Considered

Alternative: keep invalidation behavior distributed inside each edit method and command-service path.

Verdict: rejected. It can pass narrow happy-path tests, but it weakens reviewability because each mutation embeds its own route, scope checks, and cancel behavior. The deterministic proof would need many call-specific assertions and could still miss a newly added mutation path. The selected policy-table approach has a smaller review surface: one table plus one router, with orchestrator primitives providing a second safety layer only for direct callers.

## Deterministic Commands

Run from the repository root:

```bash
pnpm --filter @invoker/workflow-core test src/__tests__/invalidation-policy.test.ts src/__tests__/orchestrator.test.ts
```

Expected stable summary:

```text
Test Files  2 passed (2)
Tests       312 passed (312)
```

Observed on this worktree:

```text
Test Files  2 passed (2)
Tests       312 passed (312)
Duration    1.08s
```

Vitest also emits a stable package export warning about the `types` condition order in `package.json`; that warning is non-blocking for this experiment.

Broader confidence command used during this proof:

```bash
pnpm --filter @invoker/workflow-core test -- --run packages/workflow-core/src/__tests__/invalidation-policy.test.ts packages/workflow-core/src/__tests__/orchestrator.test.ts
```

Because of the extra `-- --run` argument shape, Vitest ran the full workflow-core suite. Expected and observed stable summary:

```text
Test Files  45 passed (45)
Tests       991 passed (991)
```

## Verdicts And Thresholds

- Policy determinism: pass only if `MUTATION_POLICIES` is frozen and every reviewed mutation maps to the expected action. Threshold: zero policy-table assertion failures.
- Router determinism: pass only if retry/recreate/fork actions call `cancelInFlight` before lifecycle dispatch and reject invalid scope/action pairs without cancellation. Threshold: zero ordering or scope assertion failures.
- Scheduling-only exception: pass only if `externalGatePolicy` is the only `scheduleOnly` policy and `scheduleOnly` never calls `cancelInFlight`. Threshold: zero cancellation calls in `scheduleOnly` tests.
- Fresh-base distinction: pass only if `recreateWorkflowFromFreshBase` clears normal recreate lineage and records a fresh base commit when supplied. Threshold: exact commit equality to the test fixture values.
- Orchestrator direct-call safety: pass only if direct retry/recreate workflow/task paths invoke cancellation before reset and preserve the retry-vs-recreate lineage distinction. Threshold: zero orchestrator invariant failures.

## Final Decision

The selected policy-table plus router design is evidence-backed. The focused deterministic command passes with 312 assertions across the router and orchestrator integration surface, and the full workflow-core run used during proof passes 991 assertions. The competing distributed-method design is rejected because it would make the same guarantees less centralized, less diffable, and harder to audit.
