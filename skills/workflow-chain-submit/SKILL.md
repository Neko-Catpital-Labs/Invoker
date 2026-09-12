---
name: workflow-chain-submit
description: >
  Submit a workflow chain headlessly, where each workflow is gated on the
  previous workflow's merge gate.
---

# workflow-chain-submit

Submit a workflow chain headlessly, where each workflow is gated on the previous workflow's merge gate.

## When to use

- You want to submit cross-workflow dependencies from CLI/headless reliably.
- You want "submit-only" behavior (return quickly, no long tracking output).
- You want to avoid manually copying workflow IDs between plans.

## What it wraps

- Script: `scripts/submit-workflow-chain.sh`

## Required inputs

1. `workflow1.yaml` (full first workflow plan)
2. `workflow2.template.yaml` (template with placeholder)
3. Optional more templates: `workflow3.template.yaml ... workflowN.template.yaml`

Each template after the first must contain:

```yaml
externalDependencies:
  - workflowId: "__UPSTREAM_WORKFLOW_ID__"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: completed
```

## Command

```bash
./scripts/submit-workflow-chain.sh <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
./scripts/submit-workflow-chain.sh --gate-policy review_ready <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
./scripts/submit-workflow-chain.sh --onto-workflow <wf-id> <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
```

## Stacked onto an existing workflow

**Stacked onto WF-X** ⇔ `externalDependencies` on WF-X `__merge__` **and** `baseBranch == WF-X.featureBranch`. A concrete extDep alone is gate-only wait, not a branch stack.

When workflow1 already depends on a prior running workflow, pass `--onto-workflow <id>` (or let the script auto-detect a single concrete non-`__UPSTREAM__` externalDependency on plan[0]) so plan[0] `baseBranch` is set to that workflow's `featureBranch` before submit.

## Output

The script prints:

- `WF1=<workflow-id>` ... `WFN=<workflow-id>` (persisted IDs in chain order)
- `RENDERED_PLAN=<temp-yaml-path>` for each rendered template (including an onto-adjusted plan[0])

## Notes

- Uses `--no-track` so submissions return without waiting for full execution.
- Resolves each submitted workflow ID from persisted workflows by `name` to avoid transient ID races.
- `--gate-policy completed|review_ready` controls cross-workflow merge-gate readiness:
  - `completed` (default): downstream waits for upstream merge gate `completed`.
  - `review_ready`: downstream can start once upstream merge gate is `review_ready`, `awaiting_approval`, or `completed`.
- `--onto-workflow <id>` attaches the chain head onto an already-running upstream by setting plan[0] `baseBranch` to that workflow's `featureBranch`.
- This skill manages Invoker workflow stacking, not GitHub PR publication policy. If the target repo is Invoker itself, publish/update the resulting GitHub PR stack with `mergify stack push` once the branch commits are ready. If the target repo is something else (for example `EdbertChan/test-playground`), keep normal PR flow unless that repo independently uses Mergify Stacks.
