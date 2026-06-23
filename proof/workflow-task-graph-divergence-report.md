# Workflow / Task-Graph Status Divergence Proof Report

## What this proves

A workflow label can show a failed `WorkflowMeta.status` while the selected
task-graph node still shows a running `TaskState.status`.

The executable proof lives in:

```
packages/ui/src/__tests__/workflow-task-graph-status-divergence-repro.test.tsx
```

## Commands checked

Primary repro command: `run-primary-divergence-repro`.

Adjacent check commands: `run-adjacent-state-checks`.

Both command tasks exited with code `0`.

## Cause

Workflow labels read `WorkflowMeta.status`, while task-graph nodes read
`TaskState.status`. `WorkflowMeta.status` is an aggregate rollup, and
`packages/workflow-graph/src/workflow-rollup.ts` reports `failed` as soon as any
task has failed, even while a separate live task status is still `running`.

Task deltas and workflow metadata also travel through separate renderer update
paths in `packages/ui/src/hooks/useTasks.ts`. That creates a workflow-metadata
catch-up seam: the task graph can show the latest live task state before the
workflow label receives the metadata update that catches it up.
