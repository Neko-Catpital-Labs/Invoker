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
- `--gate-policy approved|review_ready` controls cross-workflow merge-gate readiness:
  - `review_ready` (default): downstream can start once upstream merge gate is `review_ready`, `awaiting_approval`, or `completed`.
  - `approved`: downstream waits for upstream merge gate `completed`.
- This skill manages Invoker workflow stacking, not GitHub PR publication policy. If the target repo is Invoker itself, publish/update the resulting GitHub PR stack with `mergify stack push` once the branch commits are ready. If the target repo is something else (for example `EdbertChan/test-playground`), keep normal PR flow unless that repo independently uses Mergify Stacks.
