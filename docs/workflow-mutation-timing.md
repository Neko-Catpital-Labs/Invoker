# Workflow Mutation Timing

Invoker records timing spans for workflow recreate/rebase/retry mutations as
`workflow.mutation.timing` task events. The event is attached to the workflow's
merge gate when one exists, otherwise the first task in the workflow.

The payload includes:

- `workflowId`, `channel`, `intentId`, and `traceId` when available.
- `function` and `phase`.
- `at`, `offsetMs`, and `durationMs` for completed/failed spans.
- Operation counts such as `queueWaitMs`, `startedCount`, `branchCount`, or
  `runningCancelledCount` where the function has that data.

To inspect the persisted timeline, first identify the merge gate task for the
workflow, then use the existing audit query:

```sh
invoker --headless query tasks <workflowId> --output json
invoker --headless query audit <mergeTaskId> --output json
```

Filter for `eventType === "workflow.mutation.timing"` and sort by event id.
For live debugging, filter logs by the same `intentId` or `traceId`.
