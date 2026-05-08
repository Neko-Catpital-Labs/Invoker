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
    requiredStatus: completed
```

## Command

```bash
./scripts/submit-workflow-chain.sh <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
./scripts/submit-workflow-chain.sh --gate-policy review_ready <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
```

## Output

The script prints:

- `WF1=<workflow-id>` ... `WFN=<workflow-id>` (persisted IDs in chain order)
- `RENDERED_PLAN=<temp-yaml-path>` for each rendered template

## Notes

- Uses `--no-track` so submissions return without waiting for full execution.
- Resolves each submitted workflow ID from persisted workflows by `name` to avoid transient ID races.
- `--gate-policy completed|review_ready` controls cross-workflow merge-gate readiness:
  - `completed` (default): downstream waits for upstream merge gate `completed`.
  - `review_ready`: downstream can start once upstream merge gate is `review_ready`, `awaiting_approval`, or `completed`.
- This skill manages Invoker workflow stacking, not PR publication strategy. Publication strategy is resolved per-workflow by the execution engine's strategy router (`packages/execution-engine/src/publication-strategy-router.ts`):
  - `github_pr` (default): `GitHubMergeGateProvider` creates a standard GitHub PR automatically.
  - `mergify_stack` (explicit opt-in): `MergifyStackProvider` runs `mergify stack push` and resolves the stacked PR. Use for Invoker-on-Invoker workflows or repos that independently adopt Mergify Stacks.
  - Do not set `mergify_stack` on workflows targeting repos that do not use Mergify Stacks (e.g. `EdbertChan/test-playground`).
