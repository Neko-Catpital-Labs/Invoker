# Choke-Point SLAs

## Rule

Every choke point must declare both:

- **Completeness:** the observable work that must be included before the path can report success.
- **Latency budget:** the maximum time allowed for the path to acknowledge or finish the work it owns.

A choke point is any recurring boundary where user experience, automation, or CI
waits on a shared subsystem: Electron main-process IPC, UI status polling,
workflow/task selection, context menus, and PR-facing quality gates.

## Confirmed Budgets

| Choke point | Completeness requirement | Latency budget | Source |
| --- | --- | --- | --- |
| User-visible UI action | The user sees an acknowledgment: pending state, selection, overlay, menu, or other immediate feedback. | Ack within 200ms. | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Workflow selection | The selected workflow mini-DAG is visible and bound to the clicked workflow. | Visible within 100ms. | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Main-process cheap IPC under load | Concurrent cheap IPC such as `listWorkflows` and `getWorkerStatus` remains accepted while status work is running. | p95 <= 200ms, max sample <= 250ms. | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Task and workflow context menus | The requested menu becomes visible and stays interactive. | Visible within 200ms. | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| PR-facing quality jobs | Each required PR quality job or Playwright shard finishes its own configured work. | Under 5 minutes per budgeted job or shard. | [CI duration invariant](./ci-duration-invariant.md) |

## Completeness Standard

A choke-point SLA is incomplete unless it names:

1. The entry point or user action.
2. The success signal that proves the path is complete.
3. The latency budget and whether it measures acknowledgment or full completion.
4. The enforcement surface: unit test, Playwright spec, CI timeout, telemetry, or
   an explicitly named manual check.
5. Any known exclusions, such as background worker ticks that may continue after
   the UI acknowledgment.

Completeness is not satisfied by a passing test alone. The durable architecture
note must say what the test protects and which latency budget it confirms.

## Design Notes

- Acknowledgment budgets protect perceived responsiveness; they do not require
  background work to finish inside the same window.
- Main-process budgets protect the Electron event loop. Synchronous SQLite reads
  on timer, status, or user-gesture paths must stay bounded; see
  [main-process read hot paths](./main-process-read-hot-paths.md).
- CI budgets protect review latency. If a PR-facing job needs more time, split
  the shard or move the work to an extended battery instead of raising the
  budget.
- New choke points should extend the table above when their budgets are
  confirmed, rather than leaving SLA knowledge only in tests or fixtures.
