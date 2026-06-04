# INV-55 Experiment Brief

Date: 2026-06-04

## Objective

Establish deterministic proof for the experiment lifecycle and reselection invalidation behavior in workflow-core. The proof must make the selected architecture reviewable, compare it against a competing design, and point to concrete files under test.

## Files Under Test

- `packages/workflow-core/src/invalidation-policy.ts`
  - `MUTATION_POLICIES.selectedExperiment` and `selectedExperimentSet` map to `recreateTask` and are active-invalidating (`lines 45-64`).
  - `ACTION_SPECS.recreateTask` is task-scoped, invalidating, cascades downstream, and selects the target task plus descendants (`lines 244-250`).
  - `buildOrchestratorOnlyInvalidationDeps` wires `recreateTask` to `orchestrator.recreateTask` (`lines 485-491`).
- `packages/workflow-core/src/orchestrator.ts`
  - `selectExperiment` computes changed selection, cancels active downstream work, writes the new winner lineage, then dispatches the policy-selected recreate action on direct downstream consumers (`lines 2094-2166`).
  - `selectExperiments` applies the same cancel-first and policy-selected recreate reset path for changed multi-selection sets (`lines 2168-2254`).
  - `handleSpawnExperiments` creates scoped experiment tasks plus one reconciliation output node and rewires downstream through that reconciliation node (`lines 4590-4650`).
  - `checkExperimentCompletion` records both completed and failed experiment results before reconciliation review (`lines 4677-4715`).
- `packages/workflow-core/src/__tests__/experiment-lifecycle.test.ts`
  - Lifecycle coverage: spawn, reconciliation, selection, downstream unblock, partial failure, five variants, and multi-select (`lines 238-421`, `585-655`, `796-864`).
  - Reselection invalidation coverage: policy classification, active cancel-before-recreate ordering, inactive reset, initial no-op reset, generation bump, lineage clearing, same-winner no-op, and multi-select set semantics (`lines 892-1055`, `1116-1319`).

## Selected Architecture

Use a single reconciliation node as the experiment decision point. Initial selection completes reconciliation and unblocks downstream without resetting anything that has not run yet. A changed selection or changed selection set is treated as an execution-spec-invalidating mutation for downstream consumers: active downstream work is cancelled first, then direct downstream consumers are recreated so their descendants rerun against the new winner lineage.

Evidence:

- Policy table selects `recreateTask` for `selectedExperiment` and `selectedExperimentSet`.
- Orchestrator implementation preserves the reconciliation node identity while updating `execution.selectedExperiment`, `execution.selectedExperiments`, `branch`, and `commit`.
- Downstream consumers are reset through `MUTATION_POLICIES.selectedExperiment*.action` on changed reselection, not on initial selection or same-selection repeats.
- Tests assert downstream execution generation increases by exactly one and stale downstream lineage fields are cleared after changed reselection.

## Competing Design Considered

Alternative: retry-class downstream reset on changed selection.

This would treat winner changes as downstream-input changes while preserving more downstream execution lineage. It is cheaper but weaker for auditability because stale branch, workspace, session, container, error, or exit-code state could survive a changed experiment decision unless every retry path clears the same fields as recreate. It also conflicts with the executable policy and tests: `MUTATION_POLICIES.selectedExperiment.action` and `selectedExperimentSet.action` are asserted as `recreateTask`, and the lineage-clearing test requires stale downstream fields to become `undefined`.

Verdict: reject retry-class for INV-55. The selected recreate-class path is more conservative and is backed by deterministic tests for cancel ordering, generation bump, and stale lineage clearing.

## Deterministic Proof Commands

### Runtime Proof

Command:

```sh
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/experiment-lifecycle.test.ts --reporter=verbose
```

Expected stable summary:

```text
Test Files  1 passed (1)
Tests  30 passed (30)
```

Expected key test names in the verbose output:

```text
MUTATION_POLICIES.selectedExperiment is recreate-class and active-invalidating
re-selecting with ACTIVE downstream cancels first, then routes through recreateTask
re-selection bumps downstream execution generation by exactly one
re-selection preserves reconciliation lineage but clears downstream lineage
MUTATION_POLICIES.selectedExperimentSet is recreate-class and active-invalidating
re-selecting CHANGED set with ACTIVE downstream cancels first, then routes through recreateTask
same-set re-selection is order-insensitive (set semantics, not list semantics)
```

Threshold:

- Exit code is `0`.
- Exactly `1` test file passes.
- Exactly `30` tests pass.
- No failed, skipped, or todo tests are reported for `src/__tests__/experiment-lifecycle.test.ts`.

Observed output on 2026-06-04:

```text
Test Files  1 passed (1)
Tests  30 passed (30)
```

### Static Source-Invariant Proof

Command:

```sh
node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';

const policy = readFileSync('packages/workflow-core/src/invalidation-policy.ts', 'utf8');
const orchestrator = readFileSync('packages/workflow-core/src/orchestrator.ts', 'utf8');
const test = readFileSync('packages/workflow-core/src/__tests__/experiment-lifecycle.test.ts', 'utf8');

function section(haystack, start, end) {
  const a = haystack.indexOf(start);
  const b = haystack.indexOf(end, Math.max(a, 0));
  return a >= 0 && b > a ? haystack.slice(a, b) : '';
}

function ordered(haystack, first, second) {
  const a = haystack.indexOf(first);
  const b = haystack.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
}

const singleSelect = section(orchestrator, 'selectExperiment(taskId: string, experimentId: string)', '  selectExperiments(');
const multiSelect = section(orchestrator, '  selectExperiments(', '  restartTask(');
const spawn = section(orchestrator, 'private handleSpawnExperiments', '  private handleSelectExperiment');
const completion = section(orchestrator, 'private checkExperimentCompletion', '  private checkWorkflowCompletion');

const checks = [
  ['policy selectedExperiment uses recreateTask', /selectedExperiment:\s*\{[^}]*action:\s*'recreateTask'/.test(policy)],
  ['policy selectedExperimentSet uses recreateTask', /selectedExperimentSet:\s*\{[^}]*action:\s*'recreateTask'/.test(policy)],
  [
    'single reselection cancels before policy-selected recreate dispatch',
    ordered(singleSelect, 'this.cancelTask(dsId)', 'MUTATION_POLICIES.selectedExperiment.action') &&
      singleSelect.includes('this.dispatchPostMutation(reselectionAction, dsId)'),
  ],
  [
    'multi reselection cancels before policy-selected recreate dispatch',
    ordered(multiSelect, 'this.cancelTask(dsId)', 'MUTATION_POLICIES.selectedExperimentSet.action') &&
      multiSelect.includes('this.dispatchPostMutation(reselectionAction, dsId)'),
  ],
  ['spawn creates experiment tasks and reconciliation output', spawn.includes('isReconciliation: true') && spawn.includes('outputNodeId: reconciliationId')],
  ['completion records completed and failed experiment results', completion.includes("dep.status === 'completed' || dep.status === 'failed'") && completion.includes('execution: { experimentResults }')],
  ['tests assert active cancel then recreate routing', test.includes('re-selecting with ACTIVE downstream cancels first, then routes through recreateTask')],
  ['tests assert downstream lineage cleared on reselection', test.includes('re-selection preserves reconciliation lineage but clears downstream lineage')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
EOF
```

Expected output:

```text
PASS policy selectedExperiment uses recreateTask
PASS policy selectedExperimentSet uses recreateTask
PASS single reselection cancels before policy-selected recreate dispatch
PASS multi reselection cancels before policy-selected recreate dispatch
PASS spawn creates experiment tasks and reconciliation output
PASS completion records completed and failed experiment results
PASS tests assert active cancel then recreate routing
PASS tests assert downstream lineage cleared on reselection
```

Threshold:

- Exit code is `0`.
- Exactly `8` checks print `PASS`.
- No `FAIL` lines print.

## Verdict

INV-55 selects the recreate-class reselection architecture for experiment decisions. The runtime suite proves the lifecycle and invalidation behavior end to end, while the static invariant proof confirms that policy, orchestrator implementation, and tests agree on the selected behavior.

Implementation consumption note: the stale retry-class comment above `selectExperiment` was corrected in the implementation task, and downstream reselection reset now dispatches through `MUTATION_POLICIES.selectedExperiment*.action` so the recreate-class verdict is the executable source of truth.
