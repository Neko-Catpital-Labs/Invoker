# Workflow / task-graph status divergence — proof report

## What this proves

A workflow label can read `failed` while the same workflow's selected
task-graph node still reads `RUNNING`. The reproduction lives in
`packages/ui/src/__tests__/workflow-task-graph-status-divergence-repro.test.tsx`.

This is a scaffold. Later workflow command tasks run the proof (the focused
UI test) and record the result here. No production source is changed.

## Expected cause: split renderer state

The two statuses come from separate renderer paths that can disagree:

- **Workflow labels read `WorkflowMeta.status`.** `WorkflowNode` renders the
  workflow metadata status.
- **Task-graph nodes read `TaskState.status`.** The selected mini-DAG renders
  each task's own status (and running phase).
- **Workflow rollups return `failed` before `running`.**
  `computeWorkflowRollupFromSummaries` reports `failed` as soon as any task has
  failed, even while another task is still running.
- **Workflow metadata can arrive after task deltas.** `useTasks` updates tasks
  and workflows through separate channels, so a task delta that moves a task
  back to `running` can land before the matching workflow-metadata update — the
  label lags the task graph until the workflow channel catches up.

## Expected pass condition

The later command tasks that run the focused test exit with code `0`.
