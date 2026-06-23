# Workflow / Task-Graph Status Divergence — Proof Report

## What this proves

A workflow label can show a **failed** `WorkflowMeta.status` right next to a
selected task-graph node that still shows a **RUNNING** `TaskState.status`.

The executable proof lives in:

```
packages/ui/src/__tests__/workflow-task-graph-status-divergence-repro.test.tsx
```

Later workflow command tasks run that test to confirm the divergence. This
report is just the scaffold that records the expected cause; it does not assert
or contain any product fix.

## Expected cause: split renderer state

The workflow label and the task-graph nodes are fed by **separate renderer
paths**, so they can disagree:

- **Workflow labels read `WorkflowMeta.status`.** The workflow node renders the
  rolled-up workflow status.
- **Task-graph nodes read `TaskState.status`.** The selected mini-DAG renders
  each task's own status (e.g. `RUNNING · EXECUTING`).
- **Workflow rollups return `failed` before `running`.**
  `packages/workflow-graph/src/workflow-rollup.ts` reports `failed` as soon as
  any task has failed, even while another task is still running.
- **Workflow metadata updates can arrive after task deltas.**
  `packages/ui/src/hooks/useTasks.ts` updates tasks and workflows through
  separate renderer paths, so an `onWorkflowsChanged` update can land after the
  task delta that moved a task back to running — the label lags the task graph.

## Expected pass condition

The later command tasks that run this proof exit with code `0`.
