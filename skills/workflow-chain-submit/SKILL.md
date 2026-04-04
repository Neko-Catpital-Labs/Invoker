# workflow-chain-submit

Submit a two-workflow chain headlessly, where workflow 2 is gated on workflow 1's merge gate.

## When to use

- You want to submit cross-workflow dependencies from CLI/headless reliably.
- You want "submit-only" behavior (return quickly, no long tracking output).
- You want to avoid manually copying workflow IDs between plans.

## What it wraps

- Script: `scripts/submit-workflow-chain.sh`

## Required inputs

1. `workflow1.yaml` (full first workflow plan)
2. `workflow2.template.yaml` (second workflow template with placeholder)

`workflow2.template.yaml` must contain:

```yaml
externalDependencies:
  - workflowId: "__UPSTREAM_WORKFLOW_ID__"
    requiredStatus: completed
```

## Command

```bash
./scripts/submit-workflow-chain.sh <workflow1.yaml> <workflow2.template.yaml>
```

## Output

The script prints:

- `WF1=<workflow-id>` (persisted ID for workflow 1)
- `WF2=<workflow-id>` (workflow 2 ID when available)
- `PLAN2_RENDERED=<temp-yaml-path>` (rendered second plan path)

## Notes

- Uses `--no-track` so submissions return without waiting for full execution.
- Resolves workflow 1 ID from persisted workflows by `name` to avoid transient ID races.

