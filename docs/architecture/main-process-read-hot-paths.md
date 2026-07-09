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

## Rules

1. **No unbounded reads on timer or status IPC paths.**
   Prefer `LIMIT`, type filters, or aggregates (`COUNT` / `MAX`). Never
   `SELECT * FROM events WHERE task_id = ?` (or equivalent full-history loads)
   from a poll.

2. **Poll cost must be O(1) or O(workers), not O(tasks × events).**
   If a status endpoint walks every workflow and every task, it is wrong for a
   1–2s UI poll.

3. **No intentional poll staleness on status IPC.**
   Prefer indexed bounded reads on every poll over TTL caches that hide
   freshness. Moving sync SQLite off the Electron main thread is INV-265.

4. **Index every `WHERE` + `ORDER BY` used by polls.**
   Missing indexes turn "LIMIT 5" into a multi-ten-ms scan on large tables.

5. **Large text columns stay off hot paths.**
   Attempt `error` blobs can be multi-MB. Projection helpers must not load every
   attempt row for a node just to pick the newest active one.

## Known hot paths

| Path | Cadence | Must stay cheap |
| --- | --- | --- |
| `useWorkerStatus` → `getWorkerStatus` → `snapshot()` | ~2s | Recovery via aggregates; indexed `listWorkerActions` (no TTL cache) |
| Main `dbPollInterval` → `loadTasks` | ~2s | Projection must not unbounded-scan attempts |
| Task inspector `getEvents(taskId)` | on demand | Prefer bounded reads when only recent audit is needed |

## Preferred APIs

- Events: `countEventsByTypes`, `getEventsByTypes(..., limit)` — not full
  per-task history for status summaries.
- Attempts: indexed `LIMIT 1` for "newest active" — not `loadAttempts(nodeId)`
  on every projection.
- Worker actions: `listWorkerActions({ workerKind, limit })` backed by
  `idx_worker_actions_kind_updated`.

## How to catch regressions

- Unit cost guards under fat fixtures (many events / large attempt errors).
- Main-process hitch e2e (`packages/app/e2e/main-process-hitch-responsiveness.spec.ts`):
  while worker-status polls against a seeded fat DB, cheap IPC RTT must stay
  under budget (window-drag stickiness maps to main-loop stalls, not renderer
  frame gaps alone). Included in GitHub Playwright shards (merge-queue / master).
- Slow-query telemetry: `SQLiteAdapter` logs statements slower than 25ms
  (`slowQueryThresholdMs` / `onSlowQuery`) so the next spike shows up without
  attaching a sampler. Set `slowQueryThresholdMs: 0` to disable.

See also: [CI duration invariant](./ci-duration-invariant.md).
