# INV-90 Deterministic Experiment Brief

## Goal

Establish reviewable proof that workflow invalidation uses an explicit policy router with scoped lifecycle actions, rather than an implicit or blanket reset strategy.

## Files Under Test

- `packages/workflow-core/src/invalidation-policy.ts`
- `packages/workflow-core/src/orchestrator.ts`
- `packages/workflow-core/src/__tests__/orchestrator.test.ts`
- `packages/workflow-core/src/__tests__/invalidation-policy.test.ts`

## Selected Approach

The selected design is the policy-table plus router model in `invalidation-policy.ts`.

- `MUTATION_POLICIES` maps each mutation key to an action and invalidation flags.
- `applyInvalidation` validates scope/action compatibility, skips cancellation for `scheduleOnly`, and runs `cancelInFlight` before retry/recreate/fork workflow lifecycle deps.
- `Orchestrator` implements the concrete lifecycle semantics:
  - `retryTask` and `retryWorkflow` preserve valid lineage such as branch/workspace context while clearing volatile attempt fields.
  - `recreateTask` and `recreateWorkflow` clear lineage and replace selected attempts.
  - `recreateWorkflowFromFreshBase` refreshes base state before the recreate reset.
  - `setTaskExternalGatePolicies` persists scheduling policy and runs an unblock pass without retrying or recreating execution.
  - `forkWorkflow` is the workflow-scope action for live topology changes.

Concrete references:

- `packages/workflow-core/src/invalidation-policy.ts:45` defines the frozen policy table.
- `packages/workflow-core/src/invalidation-policy.ts:143` handles `scheduleOnly` without `cancelInFlight`.
- `packages/workflow-core/src/invalidation-policy.ts:196` enforces cancel-first for retry/recreate/fork actions.
- `packages/workflow-core/src/orchestrator.ts:2216` implements retry-task lifecycle.
- `packages/workflow-core/src/orchestrator.ts:2439` implements recreate-task lifecycle.
- `packages/workflow-core/src/orchestrator.ts:2517` implements recreate-workflow lifecycle.
- `packages/workflow-core/src/orchestrator.ts:2620` documents the fresh-base workflow recreate distinction.
- `packages/workflow-core/src/orchestrator.ts:3336` implements scheduling-only external gate policy edits.
- `packages/workflow-core/src/orchestrator.ts:3397` implements workflow fork lifecycle.

## Competing Design Considered

Alternative: route every execution-adjacent mutation through a blanket `recreateWorkflow` or `recreateTask` reset.

Why rejected:

- It would discard valid workspace lineage for retry-class edits such as `runnerKind`, `mergeMode`, and `fixContext`, contradicting the tests that assert lineage preservation for retry paths.
- It would cancel or restart work for external gate policy changes, even though the policy is scheduling-only and does not alter the execution ABI.
- It would hide the fresh-base distinction because plain `recreateWorkflow` and `recreateWorkflowFromFreshBase` would collapse into the same observable behavior.
- It would make topology mutations look like in-place edits instead of fork-class workflow mutations.

Verdict: the selected policy router is more precise and more reviewable because each mutation row has a named action, scope, cancellation rule, and deterministic test expectation.

## Deterministic Commands

Run from the repository root.

```bash
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/invalidation-policy.test.ts src/__tests__/orchestrator.test.ts
```

Expected output summary:

```text
Test Files  2 passed (2)
Tests       312 passed (312)
```

Observed on 2026-05-18:

```text
Test Files  2 passed (2)
Tests       312 passed (312)
Duration    3.87s
```

The run also emits an existing package export-order warning:

```text
The condition "types" here will never be used as it comes after both "import" and "require"
```

This warning is not part of INV-90 behavior and does not fail the command.

## Proof Points

Policy matrix proof:

- `invalidation-policy.test.ts` asserts command, prompt, execution agent, runner kind, pool member, experiment selection, merge mode, fix context, rebase/retry, external gate policy, and topology actions against `MUTATION_POLICIES`.
- Threshold: policy table must be frozen, `externalGatePolicy` must be the only `scheduleOnly` entry, and `topology` must map to `workflowFork`.
- Verdict: pass, because the focused command reports `src/__tests__/invalidation-policy.test.ts (32 tests)`.

Router ordering proof:

- `applyInvalidation` tests assert `cancelInFlight` runs before `retryTask`, `recreateTask`, `retryWorkflow`, `recreateWorkflow`, `recreateWorkflowFromFreshBase`, and `workflowFork`.
- `scheduleOnly` tests assert no `cancelInFlight` call and direct routing to `deps.scheduleOnly(taskId)`.
- Threshold: every cancel-first route must compare invocation order successfully; schedule-only must have zero cancel calls.
- Verdict: pass.

Task lifecycle proof:

- `orchestrator.test.ts:3324` verifies command edits recreate tasks, cancel active work first, skip cancel for inactive work, invalidate downstream dependents, and avoid creating forked task clones.
- `orchestrator.test.ts:3711` and surrounding tests verify retry-class runner-kind edits preserve valid lineage for same-host/substrate-only changes, while host changes recreate and clear workspace lineage.
- Threshold: generation bumps exactly once per actual edit, downstream dependents become pending, and unchanged task counts prove no accidental clone/fork.
- Verdict: pass.

Workflow lifecycle proof:

- `orchestrator.test.ts:6425` verifies `retryWorkflow`, `recreateWorkflow`, and `recreateWorkflowFromFreshBase` remain distinct.
- Threshold: `retryWorkflow` preserves branch/workspace/commit for the reset task; `recreateWorkflow` clears branch/workspace/commit without recording fresh base; `recreateWorkflowFromFreshBase` clears lineage and records the fresh base commit before reset.
- Verdict: pass.

Scheduling-only proof:

- `orchestrator.ts:3336` and policy-router tests encode external gate edits as `scheduleOnly`.
- Threshold: gate policy edits must persist external dependency policy, run an unblock pass, and avoid retry/recreate/cancel generation churn.
- Verdict: pass.

## Acceptance Thresholds

- The focused command exits with code `0`.
- Exactly two focused test files pass when using the command above.
- At least 312 tests pass across those two files.
- No INV-90 proof point may depend on wall-clock timing, randomized IDs, network access, or external services.
- Reviewers can trace each verdict to the concrete files listed in this brief.

## Final Verdict

INV-90 is supported by deterministic experiment evidence. The selected policy-router architecture preserves intentional distinctions between retry, recreate, fresh-base recreate, schedule-only, and workflow-fork actions, while the competing blanket recreate design fails the documented lineage, scheduling, and fresh-base thresholds.
