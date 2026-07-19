# Main-Process Read Hot Paths

The Electron main process owns persistence, workflow state, and IPC handlers. Cheap reads must stay cheap even when an unrelated UI action is doing heavier work.

## Current Cheap Probe

`invoker:list-workflows` is the primary read hot path used by responsiveness gates. It returns workflow metadata and rollups through the normal renderer IPC bridge. Because it is cheap and common, delayed `listWorkflows` round trips are a strong signal that the main process is blocked by synchronous work elsewhere.

## Planning Chat Send

`invoker:planning-chat-send` is a main-process responsiveness hot path. It restores and persists `PlanConversation` state through the conversation repository, builds the planner prompt, and waits for the planner response. The planner/model wait is asynchronous, but transcript load, prompt construction, and persistence bookkeeping run on the main process.

The main risk is full-transcript persistence work during a send. With a long planning history, reloading or rewriting every message can block the main process and delay unrelated reads such as `listWorkflows`. That is the same failure mode users experience as a beachball: the renderer may still be painted, but its IPC calls queue behind main-process synchronous work.

## Gate Coverage

`packages/app/e2e/planning-chat-hitch-responsiveness.spec.ts` covers this path by seeding long transcript pressure, opening the planning chat, sending one deterministic planner message, and sampling `listWorkflows` while the send is in flight.

The gate fails if:

- p95 `listWorkflows` RTT exceeds 150 ms,
- max `listWorkflows` RTT exceeds 750 ms,
- the send path does not append the user and assistant turn deterministically.

This maps the persistence invariant to user-visible responsiveness: planning chat send may append a turn and build a prompt, but it must not perform main-thread full-history replay work that stalls unrelated workflow reads.

See also: [UI action responsiveness invariant](./ui-action-responsiveness-invariant.md).
