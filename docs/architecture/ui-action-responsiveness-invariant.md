# UI Action Responsiveness Invariant

## Rule

Any user-visible action must acknowledge promptly and must not monopolize the
Electron main-process event loop.

- Click/key/send -> immediate UI feedback or an accepted async operation.
- Cheap concurrent IPC such as `listWorkflows` must remain responsive while
  expensive work is in flight.
- Main-process RTT under responsiveness gates should stay below explicit hitch
  budgets. The planning-chat gate uses p95 <= 150ms and max <= 250ms.

This does not require background work, agent/model calls, git operations, or
SQLite writes to finish inside the acknowledgement window. It requires those
operations to yield so the OS window, menu handling, and other IPC requests do
not beachball.

## Planning Chat Send

`planningChatSend` is a user gesture and a main-process responsiveness hot path.
Long planner transcripts are expected, but sending another turn must not reload
or rewrite the full persisted transcript on the send path. The restored
conversation can keep its in-memory history for prompt construction, then persist
only the new user/assistant messages.

The Playwright gate at
`packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` opens a restored
planning chat, seeds long transcript pressure, sends a deterministic planner turn
with a delayed test override response, and samples `listWorkflows` RTT while the
send is in flight. It logs one structured evidence line containing transcript
size, send elapsed time, sample count, p95 RTT, max RTT, and budgets.

## Beachball Mapping

macOS beach balls and Linux window drag stalls both mean the main process stopped
servicing the event loop. A planning response may take seconds or minutes, but
the wait must be asynchronous. The failure class this invariant prevents is
sync SQLite or serialization work on the send path, especially full transcript
loads or O(n) persistence rewrites that block unrelated IPC.

## Enforcement

| Layer | Gate |
| --- | --- |
| Unit | `packages/app/src/__tests__/planning-chat-send-main-process-cost.test.ts` rejects full transcript reloads after restore and requires delta message writes. |
| Playwright | `packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` asserts `listWorkflows` RTT p95 <= 150ms and max <= 250ms during `planningChatSend`. |
| Architecture | This doc and `docs/architecture/main-process-read-hot-paths.md` classify planning chat send as a main-process hot path. |

## Design Notes

- Open/restore may hydrate an existing transcript before the send interaction.
- Send must not call back into `loadMessages` for the same restored transcript.
- Test override responses are allowed only in `NODE_ENV=test`; production still
  routes through the real planning agent path.
- Structured CI evidence should stay single-line JSON so failures are easy to
  triage from logs.
