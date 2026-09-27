# Choke-Point SLAs

## Rule

Choke points must preserve **completeness** before optimizing for throughput.

A choke point is any shared path that can delay, filter, batch, or summarize
workflow state before an operator or worker sees it. Examples include
main-process IPC handlers, status snapshots, task graph projections, worker
queues, recovery scans, and CI gates.

The SLA has two parts:

1. **Completeness.** Every authoritative state change that enters a choke point
   must either be represented in the downstream result or be explicitly marked
   as deferred, paginated, filtered by request, or outside the view's scope.
   Silent drops, hidden sampling, and TTL staleness are not acceptable
   substitutes for bounded reads.
2. **Confirmed latency budgets.** Choke points on user-visible or PR-facing
   paths must stay within the budgets already confirmed by the architecture
   invariants below.

## Confirmed Budgets

| Choke point | Budget | Source |
| --- | --- | --- |
| User-visible action acknowledgment | <= 200ms | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Electron main-process IPC accept under load | p95 <= 200ms, max sample <= 250ms | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Workflow node select to mini-DAG render | <= 100ms | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| Workflow and task context-menu visibility | <= 200ms | [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md) |
| PR-facing quality jobs and Playwright shards | < 5 minutes | [CI duration invariant](./ci-duration-invariant.md) |

These budgets describe the choke point, not the total completion time for all
background work. Long-running work may continue asynchronously after the
operator-visible acknowledgment or CI shard boundary has been satisfied.

## Completeness Contract

Choke-point implementations must make boundedness visible in the contract:

- Paginated APIs must require an explicit limit and expose how to fetch the next
  page.
- Projection APIs must document which rows, fields, or states are intentionally
  outside the projection.
- Status snapshots must prefer indexed bounded reads over cache freshness gaps.
- Worker scans must reconcile against persisted state, not lifecycle wakeups
  alone.
- CI gates must split, shard, or move extended coverage to scheduled batteries
  rather than hiding work behind a raised timeout.

If a path cannot return complete detail within its latency budget, it should
return the complete summary needed for the current view plus an explicit affordance
for deeper detail. The task inspector event history is the model: the hot path is
bounded, but older rows remain reachable through pagination.

## Enforcement

| Layer | Where |
| --- | --- |
| Architecture | This doc; [main-process read hot paths](./main-process-read-hot-paths.md), [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md), and [CI duration invariant](./ci-duration-invariant.md) |
| UI / IPC | Responsiveness e2e specs keep acknowledgments and cheap IPC under budget |
| Data access | Cost guards and pagination tests keep hot-path reads bounded without silent truncation |
| CI | Duration invariant test keeps PR-facing jobs under the confirmed 5-minute budget |

## Design Notes

- Completeness is measured against the path's stated view contract, not against
  every row in the database.
- Latency fixes should preserve that contract by adding indexes, pagination,
  projections, or asynchronous follow-up work.
- A smaller result is acceptable only when the caller requested a smaller view
  or the response makes the boundary explicit.
