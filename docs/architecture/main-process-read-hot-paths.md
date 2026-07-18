# Main Process Read Hot Paths

The Electron main process owns persistence, workflow orchestration, and the IPC
bridge. Reads that the renderer uses for liveness and refresh must stay cheap
even when a write or agent-backed action is in progress.

## Hot Reads

The primary cheap-read sentinel is `invoker:list-workflows`, exposed to the
renderer as `window.invoker.listWorkflows()`. It is intentionally used by
responsiveness gates because it is small, common, and main-process bound. If this
read develops high RTT during another action, the main process is likely blocked
by synchronous work.

Other startup and refresh paths can also become hot:

- bootstrap state serialization during window creation,
- `getTasks(true)` force refresh,
- workflow graph startup hydration,
- task/session detail reads opened from the UI.

## Planning Chat Send

`planningChatSend` is now treated as a main-process responsiveness hot path. It
can run while the user expects the rest of the UI to remain responsive, and it
touches large persisted conversation state. The critical rule is:

After `planningChatOpen` initializes a conversation, `planningChatSend` must not
reload the full persisted transcript to append the next user and assistant
messages.

The persistence implementation should use bounded metadata reads, such as
message counts, to identify new messages to append. Full transcript reads belong
on conversation open or explicit recovery paths, not every send.

## Gate

`packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` is the CI proof for
this hot path. While a deterministic planning send is delayed in flight, the test
samples `listWorkflows` RTT and enforces explicit p95 and max budgets. A failure
means a planning-chat change has made cheap main-process reads wait behind
planning work, which maps directly to beachball risk in the desktop UI.
