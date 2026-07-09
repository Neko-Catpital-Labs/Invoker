# Invoker Architecture: Package Dependency Map

This document defines the allowed dependency directions in the Invoker codebase. The architecture is organized into 5 layers (0-4), where packages can only depend on packages in lower layers.

## Layer 0: Foundation (No Internal Dependencies)

These packages form the foundation and have no dependencies on other workspace packages.

- **contracts** — Core types and interfaces
- **workflow-graph** — Workflow graph data structures
- **transport** — Communication primitives
- **runtime-domain** — Runtime domain models
- **runtime-service** — Runtime service abstractions
- **shell** — Shell composition root
- **ui** — UI components

## Layer 1: Core Services (Depends on Layer 0 only)

- **workflow-core** → contracts, workflow-graph
- **protocol** → contracts
- **runtime-adapters** → runtime-domain
- **graph** → workflow-graph

## Layer 2: Data & Persistence (Depends on Layers 0-1)

- **data-store** → contracts, workflow-core
- **persistence** → workflow-core
- **core** → workflow-core

## Layer 3: Business Logic (Depends on Layers 0-2)

- **execution-engine** → contracts, persistence, workflow-core
- **surfaces** → contracts, data-store, transport, workflow-core

## Layer 4: Application & Testing (Depends on Layers 0-3)

- **test-kit** → contracts, execution-engine, workflow-core
- **app** → contracts, data-store, execution-engine, surfaces, transport, workflow-core

**test-kit** is a `private: true` utility package that provides shared test harnesses, in-memory persistence stubs, mock git helpers, and an in-memory message bus. It imports from contracts (Layer 0), workflow-core (Layer 1), and execution-engine (Layer 3). Because its highest dependency is Layer 3, Layer 4 is the correct placement with no risk of dependency cycles. test-kit is never published or deployed — it exists solely to reduce boilerplate across package test suites.

## Dependency Rules

### Allowed
- Packages may depend on packages in **lower** layers
- Packages may depend on packages in the **same** layer if no cycles are created
- External npm packages are allowed

### Forbidden
- Packages may **not** depend on packages in **higher** layers
- Circular dependencies are **not** allowed
- Orphaned modules should be removed

## Plan Parser Boundary

Plan parsing currently has separate entry points across layers. The lower-layer path serves reusable workflow consumers, while the app-layer path serves user-facing surfaces that need app configuration, defaulting, and persistence normalization.

Keep shared YAML semantics aligned across those entry points. Do not move app-specific behavior into a lower layer just to remove duplication.

A future consolidation should extract only pure plan-shape parsing and task normalization into a lower layer, leave app-only defaults in an app-layer wrapper, and add parity tests for the shared fields.

## Enforcement

The dependency rules are enforced through:

1. **dependency-cruiser** — Validates package boundaries at the module level
   - Run: `pnpm run check:deps`
   - Config: `.dependency-cruiser.js`

2. **TypeScript** — Validates type references and imports
   - Run: `pnpm run check:types` (alias for `tsc -b tsconfig.build.json`)
   - Config: `tsconfig.build.json`

3. **Owner Boundary Check** — Validates runtime persistence initialization
   - Run: `bash scripts/check-owner-boundary.sh`
   - Ensures `SQLiteAdapter.create()` stays in owner modules

4. **CI** — All checks run automatically on PRs and commits
   - See: `.github/workflows/ci.yml`

## Running All Checks

```bash
# Run all architecture checks
pnpm run check:all

# Or run individually
pnpm run check:deps     # dependency-cruiser
pnpm run check:types    # tsc -b
bash scripts/check-owner-boundary.sh  # owner boundary
```

## Visualizing Dependencies

Generate a visual dependency graph:

```bash
# Install graphviz if not already installed
# Ubuntu/Debian: sudo apt-get install graphviz
# macOS: brew install graphviz

# Generate graph
pnpm exec depcruise packages --config .dependency-cruiser.js --output-type dot | dot -T svg > deps.svg
```

## Adding New Packages

When adding a new package:

1. Determine which layer it belongs to based on its dependencies
2. Update the layer rules in `.dependency-cruiser.js` if needed
3. Add the package to the appropriate layer in this document
4. Run `pnpm run check:all` to verify compliance

## Mutation Boundary Policy

All state-changing operations enter the system through one of three surfaces: UI (Electron IPC), API server (HTTP on 127.0.0.1:4100), and headless CLI. Every surface routes mutations through the same shared boundary — `WorkflowMutationFacade` (`packages/app/src/workflow-mutation-facade.ts`).

### The mutation funnel

```
┌─────────────────────────────────────────────────┐
│  Entry Surfaces                                 │
│  UI (IPC)  │  API (HTTP)  │  Headless (CLI)     │
└──────┬──────────┬──────────────┬────────────────┘
       └──────────┼──────────────┘
                  ▼
       WorkflowMutationFacade
       (mutate → filter runnable → execute → topup)
                  │
                  ▼
       Shared Actions  (workflow-actions.ts)
                  │
                  ▼
       CommandService  (workflow-local mutex)
                  │
                  ▼
       Orchestrator  (domain state machine → persistence)
```

### Invariants

1. **Single entry point.** No surface calls `Orchestrator` directly for mutations. All mutations go through `WorkflowMutationFacade`, which encapsulates the post-mutation lifecycle: call shared action → filter runnable tasks → dispatch via `TaskRunner` → run global topup.
2. **Serialized mutations.** `CommandService` enforces a per-workflow promise-chain mutex. Concurrent mutations on the same workflow are queued, never interleaved. Different workflows may execute in parallel.
3. **Command envelope.** Every mutation is wrapped in a `CommandEnvelope<P>` (`packages/contracts/src/command-envelope.ts`) carrying `commandId`, `source` (`'ui' | 'headless' | 'surface'`), `scope` (`'workflow' | 'task'`), `idempotencyKey`, and a typed `payload`.
4. **No side doors.** New mutation paths must route through the facade. Direct `SQLiteAdapter` writes from new code paths are forbidden (enforced by `bash scripts/check-owner-boundary.sh`).

### Adding a new mutation

1. Add the orchestrator primitive in `packages/workflow-core/src/orchestrator.ts`.
2. Add the shared action in `packages/app/src/workflow-actions.ts`.
3. Add the facade method in `packages/app/src/workflow-mutation-facade.ts`, using `finalizeWithTopup` or `dispatchWithTopup`.
4. Wire the facade method in each surface: `api-server.ts`, `headless.ts`, `main.ts`.
5. Add a `CommandService` method if the mutation needs envelope-based routing.
6. Add parity tests (see "Surface Parity Requirements" below).

## Typed Error Contracts

Errors crossing package or process boundaries carry a stable `code` field. Callers branch on the code, never on the message string.

### Error types by layer

| Layer | Type | Package | Codes |
|-------|------|---------|-------|
| 0 | `TransportError` | `@invoker/transport` | `NO_HANDLER`, `DISCONNECTED`, `HANDLER_ERROR`, `REQUEST_TIMEOUT` |
| 0 | `CommandError` | `@invoker/contracts` | Stable string from `CommandResult.error.code` |
| 1 | `OrchestratorError` | `@invoker/workflow-core` | `TASK_NOT_FOUND`, `TASK_ALREADY_TERMINAL`, `WORKFLOW_NOT_FOUND` |
| 1 | `PlanConflictError` | `@invoker/workflow-core` | (conflict detection with `conflictingTaskIds`) |
| 1 | `TopologyForkRequired` | `@invoker/workflow-core` | (signals immutable topology constraint) |
| 3 | `MergeConflictError` | `@invoker/execution-engine` | (carries `failedBranch`, `conflictFiles`) |

### CommandResult contract

`CommandService` methods return `CommandResult<T>`, a discriminated union:

```typescript
type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
```

Callers pattern-match on `result.ok`. No try-catch required at the call site.

### HTTP status mapping

The API server maps domain errors to HTTP status codes in `httpStatusForError()`:

| Domain error | HTTP status |
|---|---|
| `OrchestratorError` with `TASK_NOT_FOUND` or `WORKFLOW_NOT_FOUND` | 404 |
| `OrchestratorError` with `TASK_ALREADY_TERMINAL` | 409 |
| `PlanConflictError` | 409 |
| `TopologyForkRequired` | 409 |
| All other errors | 400 |
| Unhandled exceptions | 500 |

Error responses use the shape `{ error: "<message>" }`.

### Rules for new error types

1. Define a typed error class with a `code` field (string literal or enum).
2. Place it in the lowest-layer package where it originates.
3. Never throw raw `Error` across package boundaries — wrap in a typed error.
4. Add HTTP status mapping in `api-server.ts` `httpStatusForError()` if the error can reach the API surface.
5. Add a test that the error code propagates through `CommandService` as `{ ok: false, error: { code } }`.

## Surface Parity Requirements

Every mutation must produce equivalent behavior across all three entry surfaces (UI, API, headless). This is enforced by the parity regression test suite (`packages/app/src/__tests__/parity-regression.test.ts`).

### What "parity" means

1. **Facade dispatch+topup lifecycle.** Every mutation method filters runnable tasks, dispatches via `TaskRunner`, and calls `startExecution` for global topup. The result shape is `{ started, runnable, topup }`.
2. **API server → facade wiring.** Each HTTP write endpoint calls the correct facade method and returns a structured result.
3. **Headless → CommandService routing.** Each CLI verb delegates to the corresponding `CommandService` method (not directly to `Orchestrator`).
4. **CommandService → Orchestrator mutex.** Each command service method calls the correct orchestrator primitive under the workflow-scoped mutex.
5. **Cross-surface isolation.** A mutation verb on one surface never accidentally triggers an unrelated mutation path.

### Parity test groups

The parity tests cover 5 dimensions:

| Group | What it verifies |
|-------|------------------|
| Facade lifecycle | `started` → filter `runnable` → `executeTasks` → `startExecution` → topup dedup |
| API wiring | HTTP endpoint → facade method → orchestrator call → 200 `{ ok: true }` |
| CommandService routing | Envelope → correct orchestrator primitive → `{ ok: true }` |
| Mutex serialization | Same-workflow mutations serialize; different-workflow mutations interleave |
| Cross-surface isolation | `retryTask` does not trigger `recreateTask`; `approve` does not trigger `reject`; etc. |

### Adding a new endpoint: parity checklist

When adding a new mutation endpoint:

- [ ] Wire the endpoint in all three surfaces (`api-server.ts`, `headless.ts`, `main.ts`) through `WorkflowMutationFacade`.
- [ ] Add a facade lifecycle test: verify `started`, `runnable`, `topup` shape.
- [ ] Add an API wiring test: verify HTTP verb + path → facade method → 200.
- [ ] Add a CommandService routing test: verify envelope → orchestrator primitive → `{ ok: true }`.
- [ ] Add cross-surface isolation assertions: verify the new mutation does not trigger unrelated mutations.
- [ ] Run `pnpm test` in `packages/app` and `packages/workflow-core` to confirm all parity tests pass.

## Migration Notes

This architecture was established during the package reorganization effort (workflow wf-1775366106244-5). The layered architecture prevents cycles and makes the system easier to understand and maintain.

### Previous State
Before this reorganization, the codebase had:
- Circular dependencies between packages
- Unclear ownership boundaries
- Mixed concerns in the `app` package

### Current State
The new architecture:
- Enforces a strict DAG (Directed Acyclic Graph)
- Separates concerns into clear layers
- Makes the composition root (`shell`) and application entry point (`app`) explicit
- Isolates persistence initialization to owner modules only
