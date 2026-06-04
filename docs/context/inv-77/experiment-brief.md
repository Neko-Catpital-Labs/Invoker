# INV-77 Experiment Brief

Recorded: 2026-06-04

## Objective

Establish deterministic proof for the merge-gate architecture around graph mutation, execution-provider contracts, and UI merge-gate derivation. The proof must be reviewable from concrete files and repeatable from shell commands.

## Files Under Test

- `packages/workflow-core/src/graph-mutation.ts`
- `packages/workflow-core/src/__tests__/graph-mutation.test.ts`
- `packages/execution-engine/src/merge-gate-provider.ts`
- `packages/execution-engine/src/github-merge-gate-provider.ts`
- `packages/execution-engine/src/review-provider-registry.ts`
- `packages/execution-engine/src/__tests__/github-merge-gate-provider.test.ts`
- `packages/execution-engine/src/__tests__/review-provider-registry.test.ts`
- `packages/ui/src/lib/merge-gate.ts`
- `packages/ui/src/__tests__/merge-gate.test.ts`
- `tsconfig.typecheck.json`

## Selected Design

Use three explicit boundaries:

1. `packages/workflow-core/src/graph-mutation.ts` owns structural graph changes. It remaps downstream dependencies in place, applies the source node disposition, creates new nodes, and reconciles merge-gate leaf dependencies after mutation.
2. `packages/execution-engine/src/merge-gate-provider.ts` owns the provider contract. Concrete providers expose review creation, approval polling, optional closure, failed-check details, and merge-state metadata through typed results.
3. `packages/ui/src/lib/merge-gate.ts` owns pure UI derivation. Gate IDs, gate kind, gate status, leaf detection, workflow grouping, and panel headings are computed from task state and workflow metadata without execution-engine side effects.

This keeps mutation correctness in workflow-core, provider IO in execution-engine, and presentation decisions in UI code.

## Competing Design Considered

Alternative: centralize merge-gate behavior in a single execution-engine service and let workflow-core and UI query that service for leaf dependencies, statuses, and labels.

Verdict: rejected. That approach would couple UI derivation and workflow mutation to execution-engine runtime state, making deterministic unit proof harder. The selected design keeps the highest-risk graph changes in pure/in-memory tests, keeps provider behavior mocked at the process boundary, and lets UI helpers be tested with plain task objects.

## Determinism Controls

- Run package-local Vitest commands from the package directory so package dev dependencies resolve consistently.
- Set `CI=1`.
- Use one Vitest worker with `--pool=forks --maxWorkers=1 --minWorkers=1`.
- Treat Vitest `Start at`, `Duration`, and per-test millisecond timings as nondeterministic; assert exit code, pass counts, and named files instead.
- Run the cross-package typecheck from the repository root.

## Deterministic Commands

Run commands from the repository root unless a package directory is specified.

### Workflow Graph Mutation

Directory:

```sh
cd packages/workflow-core
```

Command:

```sh
env CI=1 pnpm exec vitest run src/__tests__/graph-mutation.test.ts --reporter=verbose --pool=forks --maxWorkers=1 --minWorkers=1
```

Expected output fragments:

```text
RUN  v3.2.4 .../packages/workflow-core
Test Files  1 passed (1)
     Tests  5 passed (5)
```

Verdict:

Pass. This proves `applyGraphMutationImpl` in `packages/workflow-core/src/graph-mutation.ts` remaps downstream dependencies, applies complete and stale source dispositions, creates new nodes after remapping, avoids legacy `*-v2` task creation, and emits deltas in deterministic order.

Threshold:

- Exit code must be `0`.
- Exactly `1` test file and `5` tests must pass.
- Any dependency detachment, source-disposition mismatch, unexpected versioned task ID, or delta-order regression fails the experiment.

### Execution Merge-Gate Provider Contract

Directory:

```sh
cd packages/execution-engine
```

Command:

```sh
env CI=1 pnpm exec vitest run src/__tests__/github-merge-gate-provider.test.ts src/__tests__/review-provider-registry.test.ts --reporter=verbose --pool=forks --maxWorkers=1 --minWorkers=1
```

Expected output fragments:

```text
RUN  v3.2.4 .../packages/execution-engine
Test Files  2 passed (2)
     Tests  18 passed (18)
```

Verdict:

Pass. This proves the `MergeGateProvider` contract in `packages/execution-engine/src/merge-gate-provider.ts` is exercised by both a fake provider in `review-provider-registry.test.ts` and the concrete GitHub provider in `github-merge-gate-provider.test.ts`. The tests cover provider registration, missing-provider errors, branch push, normalized base branch handling, existing PR reuse, explicit target repo resolution, missing-origin failure behavior, approval-state parsing, and review closure.

Threshold:

- Exit code must be `0`.
- Exactly `2` test files and `18` tests must pass.
- Any provider shape drift, unresolved provider lookup, wrong target repository, wrong PR identifier, approval-state parse failure, or unclear failure path fails the experiment.

### UI Merge-Gate Derivation

Directory:

```sh
cd packages/ui
```

Command:

```sh
env CI=1 pnpm exec vitest run src/__tests__/merge-gate.test.ts --reporter=verbose --pool=forks --maxWorkers=1 --minWorkers=1
```

Expected output fragments:

```text
RUN  v3.2.4 .../packages/ui
Test Files  1 passed (1)
     Tests  32 passed (32)
```

Verdict:

Pass. This proves `packages/ui/src/lib/merge-gate.ts` derives gate status, leaf tasks, workflow grouping, stable gate IDs, gate kind, plan title, panel heading, and sorted workflow groups from plain task and workflow metadata.

Threshold:

- Exit code must be `0`.
- Exactly `1` test file and `32` tests must pass.
- Any status-priority regression, leaf-detection regression, gate-ID instability, prefix parsing failure, external-review heading mismatch, or workflow grouping/sorting mismatch fails the experiment.

### Cross-Package Type Contract

Directory:

```sh
cd <repo-root>
```

Command:

```sh
pnpm run check:types
```

Expected output fragments:

```text
> invoker@0.0.3 check:types .../invoker
> tsc -p tsconfig.typecheck.json
```

Verdict:

Pass. TypeScript accepted the cross-package contract without diagnostics, including the `MergeGateProvider` interface consumed by execution-engine tests and app wiring.

Threshold:

- Exit code must be `0`.
- No TypeScript diagnostics are allowed.

## Review Threshold

The selected design is accepted only if all four commands pass on the same revision:

- Workflow mutation: `5/5` focused tests pass.
- Execution provider contract: `18/18` focused tests pass.
- UI derivation: `32/32` focused tests pass.
- Typecheck: zero diagnostics.

Any command failure, pass-count drift without an intentional test update, or missing reference to the concrete files under test blocks INV-77 proof.
