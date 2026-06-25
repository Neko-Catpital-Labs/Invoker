# Sole-Owner Database (WAL exclusive locking, no `-shm`)

## Why

Invoker died with `SIGBUS` (crash report `Electron-2026-06-24-222052.ips`) while
reading the database. In WAL mode SQLite memory-maps the wal-index sidecar
(`invoker.db-shm`) in **every** connection. If that file is truncated/shortened
while a connection holds the mapping, the next read page-faults beyond EOF and
the OS kills the whole process. Proven mechanism: `scripts/repro/repro-wal-shm-sigbus.sh`.

The only way a process becomes **immune** is to have no `-shm` at all. SQLite
provides this: WAL + `PRAGMA locking_mode = EXCLUSIVE` keeps the wal-index in
heap memory and never creates `-shm`. Verified: with exclusive locking no `-shm`
file is created, reads/writes work, and a second concurrent open is rejected
with `SQLITE_BUSY`.

That last point is the crux: **exclusive locking requires the owner to be the
sole opener of the database file.** Today it is not — see below.

## Current state (who opens the DB)

One writable **owner** (GUI `main.ts`, or standalone headless) holds the writer
lock (`packages/app/src/db-writer-lock.ts`) and opens the DB writable. Several
**non-owner** processes also open the same file read-only and therefore also map
`-shm`:

- **GUI viewer mode** — when a daemon owns the DB, the GUI runs
  `initServices({ readOnly: true })` (`packages/app/src/main.ts` ~3161-3193) and
  serves the renderer from a local read-only connection.
- **Read-only headless CLI** — `query` family, `watch`, `session`, etc.
  (`isHeadlessReadOnlyCommand`) open `readOnly: true` and read directly.
- **Headless HTTP api-server** reads directly.

Live updates already flow over IPC: the owner publishes `Channels.TASK_DELTA` /
`TASK_OUTPUT` on `IpcBus` and the viewer subscribes (`main.ts` ~3394/3441). A
partial read-delegation path also exists: `headless.query` with a `{kind}`
discriminator, client `tryDelegateQuery` (`packages/app/src/headless-delegation.ts`),
answered in two owner handlers (`main.ts` ~1686 standalone, ~3258 GUI). Only a
few kinds are delegated today (`queue`, `tasks`, `workflow-status`, `ui-perf`);
everything else still hits the local DB.

## The hard constraint

The `PersistenceAdapter` read API is entirely **synchronous**
(`packages/data-store/src/adapter.ts`: `listWorkflows(): Workflow[]`, etc.), and
the concrete `SQLiteAdapter` adds ~15 more synchronous off-interface reads used
by `registerReadOnlyIpcHandlers` (`packages/app/src/ipc-read-handlers.ts`). IPC
is async. So a drop-in "remote persistence" proxy is impossible without turning
the entire read surface async.

We avoid that by **not proxying per-call**: the viewer keeps an **in-memory
materialized view** seeded once by an async snapshot query and kept current by
the existing synchronous `TASK_DELTA` / `TASK_OUTPUT` push stream. Synchronous
reads hit memory; no DB file is opened by the viewer.

## Target architecture

- Exactly one process (the writable owner) opens `invoker.db`, in WAL
  `locking_mode = EXCLUSIVE` → no `-shm` → immune to the truncation SIGBUS.
- Every other process gets data over `IpcBus`:
  - snapshots / one-shot reads via `headless.query` kinds;
  - live updates via the existing `TASK_DELTA` / `TASK_OUTPUT` subscriptions.
- When **no** owner exists, only short-lived read-only CLI commands may open the
  file directly (the sole opener for that brief read); the persistent GUI viewer
  never does (it runs in-memory). A starting owner arbitrates through the
  `db-writer-lock` and retries acquisition, so a transient direct-open reader
  cannot race it back into the concurrent-opener failure mode.

## Slice plan (PR stack)

1. **Design doc** (this file). _docs._
2. **`exclusiveLocking` capability** in `SQLiteAdapter` — option that sets
   `PRAGMA locking_mode = EXCLUSIVE` before `journal_mode = WAL`; off by default;
   unit-tested to produce no `-shm`. _data-store._
3. **Centralize `headless.query` dispatch** into one table shared by both owner
   handlers, and add the full read-kind set (owner side) + typed client
   wrappers. _app + transport._
4. **Route read-only headless CLI** commands through the new kinds; they delegate
   when an owner exists and only open the DB directly when none does. _app._
5. **Route the headless api-server** reads the same way. _app._
6. **Viewer in-memory materialized view**: seed via a snapshot kind, apply
   `TASK_DELTA` / `TASK_OUTPUT`, re-point `registerReadOnlyIpcHandlers` at the
   view; the viewer stops opening the DB. _app._
7. **Enable `exclusiveLocking` on the writable owner** (now the sole opener);
   change the read-only fallback to error when an owner is unreachable instead of
   opening the file; update `docs/persistence-architecture-single-writer.md` and
   `scripts/check-owner-boundary.sh`. _app + data-store + docs._

Each slice is independently reviewable. Slice 7 is the one that grants immunity;
it cannot land until 3-6 remove every concurrent opener.

## Risks

- **Staleness / missed deltas** in the viewer view → reconnect must re-seed from
  a fresh snapshot; sequence/generation checks on `TASK_DELTA`.
- **Read latency** for headless one-shot queries (one IPC round-trip) — bounded
  by the existing `headless.query` timeout; acceptable for CLI.
- **No owner present** must stay usable: read-only consumers open directly only
  when there is no owner.
- **Off-interface reads** (`getOutputChunks`, `getActivityLogs`,
  `listWorkflowMutationIntents`, …) each need an explicit kind; the inventory is
  the read methods in `adapter.ts` plus the concrete reads listed above.

## Testing

- Slices 2-5: unit tests (no `-shm` with exclusive locking; each owner handler
  returns correct data per kind; headless commands delegate vs. open by owner
  presence).
- Slices 6-7: integration — launch a daemon owner + a GUI viewer, mutate via the
  owner, assert the viewer reflects changes and never opens the DB file, and that
  the owner runs with no `-shm`. Include a handoff case: a short-lived direct-open
  reader started just before/while the owner comes up must not block owner startup
  and must transition cleanly to owner-mediated access.
