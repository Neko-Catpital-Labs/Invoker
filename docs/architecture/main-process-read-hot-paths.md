# Main-Process Read Hot Paths

## Why

Electron's main process owns the OS window event loop. Synchronous SQLite reads,
large JSON serialization, or full transcript scans on that thread freeze more
than React: focus changes, window dragging, context menus, and cheap IPC all
stop responding.

Planning chat sends are part of this class. The planner can wait on an external
agent for a long time, but that wait must be asynchronous and must not pin the
main process with full conversation persistence work.

## Rules

1. No unbounded persisted reads on timer, status, or user-gesture IPC paths.
2. Long text/history data must be loaded only at explicit restore/open points or
   through paginated/bounded APIs.
3. Once a planning conversation is restored, `planningChatSend` must persist
   only the new turn. It must not reload the full transcript from SQLite during
   send.
4. Cheap IPC such as `listWorkflows` is the liveness probe: if it stalls during a
   user action, the main process is at risk of beachballing.
5. Deterministic tests must not depend on a model, network, or local agent CLI.

## Known Hot Paths

| Path | Cadence | Must stay cheap |
| --- | --- | --- |
| `planningChatOpen` / restored planner conversation | Explicit user open or recovery | May hydrate the transcript once; keep it outside the measured send interaction. |
| `planningChatSend` / `PlanConversation.sendMessage` | User send gesture | Build prompt from restored in-memory history, await planner asynchronously, then append only the new user and assistant messages. |
| `listWorkflows` | Cheap liveness probe | Must be serviceable while planning send is in flight. |
| Startup restore / bootstrap IPC | App launch | Keep large persisted reads off first-paint critical paths where possible. |

## Regression Gates

- Unit cost guard:
  `packages/app/src/__tests__/planning-chat-send-main-process-cost.test.ts`
  seeds a large restored conversation and fails if a send reloads the full
  persisted transcript instead of using delta appends.
- Playwright hitch proof:
  `packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` seeds a long
  transcript, opens the planning chat, triggers `planningChatSend` with a
  deterministic delayed response override, samples `listWorkflows` RTT while the
  send is pending, and enforces p95 <= 150ms / max <= 250ms.

## CI Evidence

The planning-chat hitch proof prints one line prefixed with
`[planning-chat-hitch]` followed by JSON:

- `transcriptMessageCount` and approximate transcript bytes
- `sendElapsedMs`
- `sampleCount`
- `p95RttMs` and `maxRttMs`
- asserted budgets

That line maps directly to beachball prevention: high RTT means unrelated IPC
could not get serviced while the send was running.
