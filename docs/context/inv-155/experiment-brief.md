# INV-155 Experiment Brief: Deterministic Mutation Proof

Recorded: 2026-06-09

## Question

Which architecture gives the workflow context menu and HTTP mutation surface the most reviewable, deterministic behavior?

## Files under test

- `packages/app/src/api-server.ts`
- `packages/app/src/workflow-mutation-facade.ts`
- `packages/ui/src/__tests__/context-menu-e2e.test.tsx`

## Selected approach

Use a thin HTTP API surface that delegates write operations to `WorkflowMutationFacade`, and keep the UI context menu contract at the API-client boundary.

Evidence anchors:

- `packages/app/src/api-server.ts:386` through `packages/app/src/api-server.ts:508` routes workflow recreate, retry, rebase-retry, rebase-recreate, and cancel through `mutations.*`.
- `packages/app/src/workflow-mutation-facade.ts:278` through `packages/app/src/workflow-mutation-facade.ts:329` centralizes workflow retry, recreate, rebase, and cancel behavior.
- `packages/app/src/workflow-mutation-facade.ts:476` through `packages/app/src/workflow-mutation-facade.ts:499` funnels started tasks through `dispatchStartedTasksWithGlobalTopup`.
- `packages/ui/src/__tests__/context-menu-e2e.test.tsx:108` through `packages/ui/src/__tests__/context-menu-e2e.test.tsx:158` proves the workflow context menu calls the expected API methods.

## Competing design

Alternative: each API route and UI action directly invokes orchestrator methods and dispatch/topup logic.

Verdict: rejected. It would make each route responsible for mutation serialization, dispatch filtering, topup, and error mapping. The current facade keeps those behaviors in one app-layer unit while the API server remains responsible for parsing, status codes, and response shape. The UI test then verifies the user gesture maps to the API method, not to implementation internals.

## Deterministic commands

### 1. API server + facade regression

Command:

```sh
pnpm --filter @invoker/app exec vitest run src/__tests__/api-server.test.ts src/__tests__/workflow-mutation-facade.test.ts
```

Expected output:

```text
Test Files  2 passed (2)
Tests  88 passed (88)
```

Threshold:

- Exit code must be `0`.
- `api-server.test.ts` and `workflow-mutation-facade.test.ts` must both pass.
- Minimum accepted count is `88 passed`; any failed test is a blocker.

Observed verdict: pass.

### 2. UI context menu contract

Command:

```sh
pnpm --filter @invoker/ui exec vitest run src/__tests__/context-menu-e2e.test.tsx
```

Expected output:

```text
Test Files  1 passed (1)
Tests  9 passed (9)
```

Threshold:

- Exit code must be `0`.
- `context-menu-e2e.test.tsx` must pass.
- Minimum accepted count is `9 passed`; any failed test is a blocker.
- Existing jsdom `HTMLCanvasElement.prototype.getContext` stderr is non-blocking only when the process exits `0` and the test summary passes.

Observed verdict: pass.

### 3. API route delegation check

Command:

```sh
rg -n "await mutations\\.(recreateWorkflow|retryWorkflow|rebaseRetry|rebaseRecreate|cancelWorkflow)" packages/app/src/api-server.ts
```

Expected output:

```text
393:          const result = await mutations.recreateWorkflow(workflowId);
419:          const result = await mutations.retryWorkflow(workflowId);
434:          const result = await mutations.rebaseRetry(workflowId);
466:          const result = await mutations.rebaseRecreate(workflowId);
503:          const result = await mutations.cancelWorkflow(workflowId);
```

Threshold:

- Exactly these five workflow mutation routes must delegate to `mutations.*`.
- No direct `orchestrator.retryWorkflow`, `orchestrator.recreateWorkflow`, or manual dispatch call should appear in those route blocks.

Observed verdict: pass.

### 4. Facade lifecycle check

Command:

```sh
rg -n "finalizeWithTopup\\(started, 'facade\\.(retry-workflow|recreate-workflow|rebase-retry|rebase-recreate)'" packages/app/src/workflow-mutation-facade.ts
```

Expected output:

```text
285:    return this.finalizeWithTopup(started, 'facade.retry-workflow', { scopedWorkflowId: workflowId });
299:    return this.finalizeWithTopup(started, 'facade.recreate-workflow', { scopedWorkflowId: workflowId });
310:    return this.finalizeWithTopup(started, 'facade.rebase-retry', { scopedWorkflowId: workflowId });
316:    return this.finalizeWithTopup(started, 'facade.rebase-recreate', { scopedWorkflowId: workflowId });
```

Threshold:

- Retry, recreate, rebase-retry, and rebase-recreate must all return through `finalizeWithTopup`.
- The scope must remain `scopedWorkflowId` so cross-workflow started tasks do not leak into the primary runnable result.

Observed verdict: pass.

## Decision

Keep the selected thin API plus centralized facade architecture. It passes deterministic app and UI tests, has concrete route-to-facade evidence, and avoids duplicating mutation dispatch/topup behavior across routes or UI actions.
