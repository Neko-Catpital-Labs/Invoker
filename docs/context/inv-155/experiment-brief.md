# INV-155 Experiment Brief

Date: 2026-05-16

## Goal

Establish deterministic proof that workflow context-menu mutations are backed by the API server's shared `WorkflowMutationFacade` lifecycle instead of entrypoint-specific mutation logic.

## Files Under Test

- `packages/app/src/api-server.ts`
  - `ApiServerDeps.mutations` is the required facade dependency at lines 54-60.
  - Task write endpoints call facade methods at lines 198-304.
  - Workflow write endpoints call `recreateWorkflow`, `retryWorkflow`, and `recreateWorkflowFromFreshBase` through `mutations` at lines 318-386.
- `packages/app/src/workflow-mutation-facade.ts`
  - The facade declares the shared lifecycle contract at lines 112-116.
  - Workflow mutations are finalized with scoped dispatch and topup at lines 232-255.
  - `dispatchWithTopup` and `finalizeWithTopup` centralize runnable filtering and global topup at lines 408-430.
- `packages/ui/src/__tests__/context-menu-e2e.test.tsx`
  - The workflow context menu exposes the workflow actions at lines 76-87.
  - The mini-DAG task menu remains task-scoped at lines 89-103.
  - Workflow menu actions call the expected UI API methods at lines 105-141.

## Selected Design

Use a single API-facing mutation facade. The API server owns HTTP parsing, status mapping, and JSON response formatting; the facade owns mutation, runnable dispatch, and scheduler topup. The UI stays at the transport boundary and proves intent by calling the workflow API methods exposed by the mock invoker.

This design is selected because it gives one deterministic lifecycle for API, headless, and main-process entrypoints while leaving request/response concerns outside the mutation layer.

## Competing Design

Duplicate mutation lifecycle code inside each API endpoint and UI-triggered path.

Verdict: rejected. The competing design would make each endpoint responsible for calling the shared action, filtering runnable tasks, dispatching, and topping up scheduler capacity. That increases drift risk between `retryWorkflow`, `recreateWorkflow`, and `recreateWorkflowFromFreshBase`, and it weakens reviewability because a reviewer must audit endpoint bodies rather than a single facade contract.

## Deterministic Commands

Run from the repository root.

### App Mutation Boundary

Command:

```sh
pnpm --filter @invoker/app exec vitest run src/__tests__/api-server.test.ts src/__tests__/workflow-mutation-facade.test.ts
```

Expected output signature:

```text
✓ src/__tests__/workflow-mutation-facade.test.ts (19 tests)
✓ src/__tests__/api-server.test.ts (67 tests)
Test Files  2 passed (2)
Tests  86 passed (86)
```

Threshold:

- Exit code must be 0.
- Exactly 2 test files must pass.
- Exactly 86 tests must pass.
- There must be 0 failed, skipped, or flaky rerun-dependent tests.

Observed on 2026-05-16:

```text
Test Files  2 passed (2)
Tests  86 passed (86)
Duration  3.73s
```

Verdict: pass. The app tests prove API write routes are wired through the facade and the facade applies scoped dispatch plus topup behavior.

### UI Context Menu Boundary

Command:

```sh
pnpm --filter @invoker/ui exec vitest run src/__tests__/context-menu-e2e.test.tsx
```

Expected output signature:

```text
✓ src/__tests__/context-menu-e2e.test.tsx (8 tests)
Test Files  1 passed (1)
Tests  8 passed (8)
```

Threshold:

- Exit code must be 0.
- Exactly 1 test file must pass.
- Exactly 8 tests must pass.
- The workflow context menu must call `retryWorkflow`, `recreateWorkflow`, `recreateWithRebase`, `cancelWorkflow`, and `deleteWorkflow` with `wf-1`.
- The mini-DAG task context menu must not expose workflow-only actions.

Observed on 2026-05-16:

```text
Test Files  1 passed (1)
Tests  8 passed (8)
Duration  6.32s
```

Verdict: pass. The UI test proves the user-facing workflow context menu maps workflow actions to workflow API calls while keeping task-menu actions scoped to tasks.

## Experiment Verdict

Selected approach passes. The proof is deterministic because it is based on focused Vitest suites with fixed mock workflows, fixed task IDs, explicit API-method assertions, and exact pass-count thresholds. The artifact references the concrete files under test and can be rerun without network, external services, or live Electron UI state.
