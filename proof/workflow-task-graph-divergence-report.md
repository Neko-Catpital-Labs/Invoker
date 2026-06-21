# Workflow/task graph divergence proof

Primary repro passed in task run-primary-divergence-repro.
Adjacent state checks passed in task run-adjacent-state-checks.

Cause: workflow labels read WorkflowMeta.status while task graph nodes read TaskState.status. WorkflowMeta.status is an aggregate rollup, and workflow-rollup returns failed before running. Task deltas and workflow metadata also arrive on separate renderer channels, so the task graph can update before the workflow label catches up.
