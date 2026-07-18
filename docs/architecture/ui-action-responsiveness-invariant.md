# UI Action Responsiveness Invariant

Invoker desktop actions that enter the Electron main process must not monopolize
the main-process event loop. A user-visible action can do real work, spawn an
agent, or wait on persistence, but cheap IPC reads must continue to complete
quickly while that action is in flight. This is the beachball prevention
invariant for the GUI.

## Invariant

For long-running or write-heavy UI actions:

- Start the action from the renderer and return to the event loop whenever the
  action waits on external work, subprocesses, timers, or I/O.
- Keep synchronous main-process work bounded before the first await and after
  each await.
- Do not re-read or re-serialize large persisted state on every UI turn when an
  initialized in-memory session already has the authoritative working state.
- Keep cheap read IPC, especially `listWorkflows`, responsive while the action
  is pending.

The practical signal is not only that the action eventually succeeds. The app
must still accept small reads during the action. If `listWorkflows` queues behind
a large synchronous block, users experience the same failure mode as a UI
beachball even if the renderer process itself is alive.

## Planning Chat Gate

`packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` is the planning
chat proof for this invariant. It:

- seeds a long persisted planning transcript,
- opens the planning conversation so the main process initializes the session,
- starts `planningChatSend` with a deterministic delayed test response,
- samples renderer-to-main `listWorkflows` RTT while the send is in flight,
- asserts p95 and max RTT remain inside explicit budgets, and
- emits one `PLANNING_CHAT_HITCH_EVIDENCE` JSON line for CI triage.

The test has no external model or network dependency. In test mode the main
process replaces the planning agent call with `INVOKER_TEST_PLANNING_CHAT_RESPONSE`
and `INVOKER_TEST_PLANNING_CHAT_RESPONSE_DELAY_MS`.

## Beachball Mapping

Planning chat send is a beachball-sensitive action because it combines three
cost centers: transcript restoration, prompt construction, and conversation
persistence. The gate protects the persistence side of that path. After a
conversation is opened, a follow-up send should append only the new messages; it
must not reload and parse the entire persisted transcript before the UI can
answer cheap IPC reads.
