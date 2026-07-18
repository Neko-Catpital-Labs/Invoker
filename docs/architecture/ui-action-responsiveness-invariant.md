# UI Action Responsiveness Invariant

Invoker desktop UI actions must not monopolize the Electron main process. A renderer action may perform durable work, but it must keep unrelated cheap IPC reads responsive while that work is in flight.

## Invariant

For user-triggered main-process actions, cheap read IPC must continue to round-trip within explicit hitch budgets while the action is running. The current cheap probe is `window.invoker.listWorkflows()`, because it exercises the renderer-to-main IPC path and the workflow metadata read path without starting task execution.

The responsiveness budget is:

- p95 `listWorkflows` RTT at or below 150 ms.
- max `listWorkflows` RTT at or below 750 ms.

These budgets are intended to catch main-process stalls before they become visible macOS beachballs or Linux compositor freezes. A single long synchronous database replay, transcript serialization pass, or terminal/session upsert can block all renderer IPC even when the renderer itself is healthy.

## Planning Chat Gate

`packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` is the planning-specific proof gate. It:

- seeds a long persisted planning transcript before measurement,
- opens the planning chat so the transcript is restored,
- starts `planningChatSend` with a deterministic test response override,
- samples `listWorkflows` RTT while the send is in flight,
- asserts p95 and max RTT against the hitch budgets,
- emits one JSON evidence line named `planning_chat_hitch_responsiveness`.

The test has no model or network dependency. The deterministic response override keeps the send alive long enough to sample IPC while preserving the real prompt construction and conversation persistence path.

## Beachball Mapping

`planningChatSend` is a hot UI action because it runs in the Electron main process and touches a potentially large persisted transcript. Regressions that reload or rewrite the full transcript during send can block unrelated IPC and make the window appear hung. The gate proves that long-transcript planning sends only do bounded synchronous work on the main thread and keep cheap workflow reads responsive.
