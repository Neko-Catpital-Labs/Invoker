# Main-Process Read Hot Paths

## Why this exists

Electron's main process owns the OS window event loop. Synchronous SQLite work
on that thread freezes more than React: window focus, dragging, and menus stop
responding.

A 2026-07 incident pegged main CPU at ~100% because a 2s worker-status poll
walked every task and ran unbounded `getEvents(taskId)` against hundreds of
thousands of event rows. After that scan was fixed, the same poll still hitching
window drag via per-kind `listWorkerActions` (~30ms × N workers) without a
matching index.

A follow-on beachball class was DAG task selection: the inspector called
unbounded `getEvents` on click, stalling main while marshaling full task
history even though the UI only rendered 20 log rows.

## Rules

1. **No unbounded reads on timer, status, or user-gesture IPC paths.**
   Prefer `LIMIT`, type filters, or aggregates (`COUNT` / `MAX`). Never
   `SELECT * FROM events WHERE task_id = ?` (or equivalent full-history loads)
   from a poll or a click handler.

2. **`invoker:get-events` is always paginated.**
   Callers must pass `{ limit }` (1..`MAX_EVENTS_PAGE`, currently 100). Optional
   `beforeId` loads older pages. Missing or oversized limits are rejected at the
   IPC / API boundary (`normalizeGetEventsOptions` / `getEventsPage`).

3. **Poll cost must be O(1) or O(workers), not O(tasks × events).**
   If a status endpoint walks every workflow and every task, it is wrong for a
   1–2s UI poll.

4. **No intentional poll staleness on status IPC.**
   Prefer indexed bounded reads on every poll over TTL caches that hide
   freshness. Moving sync SQLite off the Electron main thread is INV-265.

5. **Index every `WHERE` + `ORDER BY` used by polls.**
   Missing indexes turn "LIMIT 5" into a multi-ten-ms scan on large tables.

6. **Large text columns stay off hot paths.**
   Attempt `error` blobs can be multi-MB. Projection helpers must not load every
   attempt row for a node just to pick the newest active one.

## Known hot paths

| Path | Cadence | Must stay cheap |
| --- | --- | --- |
| `useWorkerStatus` → `getWorkerStatus` → `snapshot()` | ~2s (paused while `document.hidden`) | Recovery via aggregates; indexed `listWorkerActions` (no TTL cache) |
| `useQueueStatus` / `getQueueStatus` | ~2s (paused while hidden) | Prefer in-memory after an explicit sync; Action Graph must call `getQueueStatus({ refresh: false })` after `syncAllFromDb()`. Cache external-dep blockers per workflow inside one `getQueueStatus` call — never re-`listWorkflows` per ready task |
| `useActionGraphSnapshot` → `buildCurrentActionGraphSnapshot` | ~2s when Action Graph open (paused while hidden) | Per-task `getEvents` / `loadActionGraphAttempts` only for active/attention tasks — not every pending/completed node; never re-`refreshFromDb` inside the same snapshot |
| Main `dbPollInterval` → `loadTasks` | ~2s | Projection must not unbounded-scan attempts |
| Task inspector / History / Approval `getEvents` | on demand | Always paginated (`limit` required; History uses `beforeId` for Load more) |

## Visibility rule

UI status polls (`useWorkerStatus`, `useQueueStatus`, `useActionGraphSnapshot`) must
**not** run while `document.visibilityState !== 'visible'`. On restore they refresh
once (optionally staggered) so Cmd-Tab back from another app cannot herd deferred
timer ticks into a main-thread SQLite convoy (macOS beachball).

## Preferred APIs

- Events (UI/IPC): `getEvents(taskId, { limit, sortBy?, beforeId? })` via
  `getEventsPage` — never the 1-arg unbounded adapter overload.
- Events (status): `countEventsByTypes`, `getEventsByTypes(..., limit)` — not
  full per-task history for status summaries. `getEventsByTypes` must query each
  type with indexed `LIMIT` and merge in process (never multi-type `IN` +
  `ORDER BY created_at`, which forces `USE TEMP B-TREE`). Fetch only the rows
  the snapshot keeps (recovery status uses limit 10).
- Events (headless full audit): loop pages server-side (`loadAllEventsPaged`) —
  never one giant IPC payload.
- Attempts: indexed `LIMIT 1` for "newest active" — not `loadAttempts(nodeId)`
  on every projection.
- Worker actions: `listWorkerActions({ workerKind, limit })` backed by
  `idx_worker_actions_kind_updated`.

## How to catch regressions

- Unit cost guards under fat fixtures (many events / large attempt errors),
  including `packages/app/src/__tests__/dag-click-get-events-cost.test.ts`
  (unbounded vs page cost + reject missing limit).
- Main-process hitch e2e (`packages/app/e2e/main-process-hitch-responsiveness.spec.ts`):
  while worker-status polls against a seeded fat DB, cheap IPC RTT must stay
  under budget (window-drag stickiness maps to main-loop stalls, not renderer
  frame gaps alone). Included in GitHub Playwright shards (merge-queue / master).
- Focus-switch hitch e2e (`packages/app/e2e/focus-switch-hitch-responsiveness.spec.ts`):
  hide→show + stacked status IPC under the hitch fixture must stay under the
  same budget (Cmd-Tab beachball class).
- Unit cost: `packages/app/src/__tests__/focus-switch-main-process-cost.test.ts`
  keeps Action Graph snapshot under 100ms on a 200-task fat events table.
- DAG-click hitch e2e (`packages/app/e2e/dag-click-hitch-responsiveness.spec.ts`):
  seed fat events, click task nodes, assert `listWorkflows` RTT stays under the
  same hitch budget. Included in GitHub Playwright shards (merge-queue / master)
  and in the extended Playwright battery used by the twice-daily e2e worker.
- Slow-query telemetry: `SQLiteAdapter` logs statements slower than 25ms
  (`slowQueryThresholdMs` / `onSlowQuery`) so the next spike shows up without
  attaching a sampler. Set `slowQueryThresholdMs: 0` to disable.

See also: [CI duration invariant](./ci-duration-invariant.md) and
[UI action responsiveness invariant](./ui-action-responsiveness-invariant.md)
(user actions must acknowledge within 200ms; main/IPC must not beach-ball).
