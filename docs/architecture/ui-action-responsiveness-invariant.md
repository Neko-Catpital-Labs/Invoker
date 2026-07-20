# UI Action Responsiveness Invariant

## Rule

Any user-visible action must **acknowledge within 200ms**:

- Click / key → immediate UI feedback (optimistic state, pending control, open overlay, selection highlight).
- Electron **main-process event loop / IPC accept** must stay responsive: concurrent cheap IPC
  (`listWorkflows`, `getWorkerStatus`) under load should stay **p95 ≤ 200ms**, max sample ≤ 250ms.

**Workflow select is tighter:** clicking a workflow node must show
`selected-workflow-mini-dag` within **100ms**. That path is an in-memory task filter; it must not
wait on SQLite. Main-thread stalls from status polls (for example a TEMP B-TREE `getEventsByTypes`)
are what make this click feel laggy.

This includes **right-click context menus** on workflow nodes and task nodes: the menu must become
visible (and stay interactive) within 200ms. Opening the menu must not stall the main process.

This does **not** require background work (worker ticks, scans, git, `df`, PR maintenance) to finish
in 200ms. Long work continues asynchronously after the action is acknowledged.

### Acknowledgment examples

| Action | Ack signal |
| --- | --- |
| Worker Start / Stop | Lifecycle label / control `data-action` flips |
| Workflow select | `selected-workflow-mini-dag` visible within **100ms** |
| Task select | Selection highlight / inspector binding |
| Workflow right-click | `[data-testid="workflow-context-menu"]` visible |
| Task right-click | `[data-testid="task-context-menu"]` visible |
| Search / inspector / drawer | Overlay or panel visible |

## Why

macOS beach balls mean the **main process event loop stalled**. A common failure mode was
`stopWorker` awaiting an in-flight worker tick (autofix scan, disk-headroom `df`, PR-maintenance
shell) before resolving IPC. The UI also serialized `await start/stop` + a full status refresh on
the critical path.

## Enforcement

| Layer | Where |
|-------|--------|
| Architecture | This doc; cross-links from [main-process read hot paths](./main-process-read-hot-paths.md) and [CI duration invariant](./ci-duration-invariant.md) |
| Unit | `packages/app/src/__tests__/worker-runtime.test.ts` — default `stop()` returns promptly; `settleTimeoutMs` bounds quit |
| PR Playwright | `packages/app/e2e/main-process-hitch-responsiveness.spec.ts` — fat DB + `startWorker`/`stopWorker` IPC accept ≤ 200ms |
| PR Playwright | `packages/app/e2e/dag-click-hitch-responsiveness.spec.ts` — workflow select → mini-DAG ≤ 100ms under fat events table |
| Daily / extended | `packages/app/e2e/ui-action-responsiveness-battery.spec.ts` via `optional/41-ui-action-responsiveness.sh` (workflow select ≤ 100ms; menus ≤ 200ms) |

PR CI keeps the narrow hitch gate. The full interaction matrix runs only on the twice-daily
extended e2e worker (`scripts/daily-e2e-do-submit.sh` / `INVOKER_TEST_ALL_EXTENDED=1`).

## Design notes

- Worker runtime `stop()` aborts via `AbortSignal` and defaults `settleTimeoutMs: 0` (GUI IPC).
- Quit / `stopAll` / OS signal handlers pass a bounded settle (e.g. 5s).
- Auto-started workers are deferred past first paint (`startDeferredStartupWork`).
- Worker Start/Stop buttons use optimistic lifecycle + `data-testid`s for ack measurement.

## Follow-ups (out of scope here)

- INV-265: move sync SQLite off the main thread.
- Tighten workflow-delete budget from 500ms → 200ms once battery baselines are green.
- Bootstrap `sendSync` full-graph load (separate startup project).
