# INV-91 Experiment Brief: Deterministic Orchestration Control Plane

## Scope

INV-91 evaluates whether the current control-plane architecture is reviewable and evidence-backed across these files:

- `packages/workflow-core/src/orchestrator.ts`
- `packages/contracts/src/ipc-channels.ts`
- `packages/app/src/api-server.ts`

The selected approach is a DB-first orchestrator with typed transport contracts and a thin HTTP facade. The competing design is direct transport-layer mutation, where IPC or HTTP handlers call graph mutation primitives directly and each surface owns part of validation, state sync, and notification behavior.

## Selected Approach

The selected approach keeps mutation ownership centralized:

- `orchestrator.ts` documents the mutation sequence as DB refresh, validation, DB write/cache sync, then delta publication. Concrete anchors: `OrchestratorPersistence` at `packages/workflow-core/src/orchestrator.ts:168`, `refreshFromDb` at `packages/workflow-core/src/orchestrator.ts:818`, `writeAndSync` at `packages/workflow-core/src/orchestrator.ts:841`, and `TASK_DELTA_CHANNEL` publication at `packages/workflow-core/src/orchestrator.ts:1012`.
- `ipc-channels.ts` defines channel request/response contracts in one registry and derives `InvokerAPI` from those registries. Concrete anchors: `IpcChannels` at `packages/contracts/src/ipc-channels.ts:260`, event channels at `packages/contracts/src/ipc-channels.ts:540`, channel-to-method type derivation at `packages/contracts/src/ipc-channels.ts:568`, and `InvokerAPI` at `packages/contracts/src/ipc-channels.ts:599`.
- `api-server.ts` binds only to loopback and delegates writes to `WorkflowMutationFacade`. Concrete anchors: facade dependency at `packages/app/src/api-server.ts:59`, error status mapping at `packages/app/src/api-server.ts:132`, `startApiServer` at `packages/app/src/api-server.ts:146`, mutation calls beginning at `packages/app/src/api-server.ts:203`, and loopback binding at `packages/app/src/api-server.ts:623`.

## Competing Design

Direct transport-layer mutation was rejected for INV-91.

Under that design, IPC handlers and HTTP routes would each update task state, apply invalidation policy, and emit UI deltas. It may reduce indirection for small endpoints, but it creates multiple write paths with duplicated error mapping and partial contract drift risk. The deterministic checks below intentionally favor the selected architecture by requiring one core write/sync helper, derived IPC contracts, HTTP read-only orchestrator access, and facade-backed HTTP writes.

## Deterministic Commands

Run commands from the repository root.

### 1. Orchestrator Write Ownership

Command:

```sh
rg -c "private refreshFromDb\\(" packages/workflow-core/src/orchestrator.ts
rg -c "private writeAndSync\\(" packages/workflow-core/src/orchestrator.ts
rg -c "messageBus\\.publish\\(TASK_DELTA_CHANNEL" packages/workflow-core/src/orchestrator.ts
```

Expected output:

```text
1
1
41
```

Thresholds:

- `refreshFromDb` count must be exactly `1`.
- `writeAndSync` count must be exactly `1`.
- `TASK_DELTA_CHANNEL` publish count must be at least `1`.

Verdict: pass if there is a single orchestrator-owned refresh/write implementation and task deltas are emitted from the orchestrator path.

### 2. Typed IPC Contract Derivation

Command:

```sh
rg -c "export const IpcChannels|export const IpcEventChannels|export type InvokerAPI|type ChannelToMethod" packages/contracts/src/ipc-channels.ts
rg -c "^  'invoker:" packages/contracts/src/ipc-channels.ts
```

Expected output:

```text
4
62
```

Thresholds:

- Contract derivation anchor count must be exactly `4`.
- Registered `invoker:` channel entries must be greater than or equal to `60`.

Verdict: pass if renderer-facing API shape remains derived from centralized channel registries rather than a hand-written duplicate interface.

### 3. HTTP Facade Boundary

Command:

```sh
rg -c "^      if \\(method === 'POST'" packages/app/src/api-server.ts
rg -c "mutations\\." packages/app/src/api-server.ts
rg -n "orchestrator\\." packages/app/src/api-server.ts
rg -n "server\\.listen\\(port, '127\\.0\\.0\\.1'" packages/app/src/api-server.ts
```

Expected output:

```text
19
18
170:        const status = orchestrator.getWorkflowStatus();
177:        let tasks = orchestrator.getAllTasks();
189:        const task = orchestrator.getTask(taskId);
422:        const queueStatus = orchestrator.getQueueStatus();
623:  server.listen(port, '127.0.0.1', () => {
```

Thresholds:

- POST route count must be greater than or equal to `15`.
- Facade mutation call count must be greater than or equal to `15`.
- Direct `orchestrator.` references in `api-server.ts` must be read-only getters/status/queue calls.
- Server binding must be `127.0.0.1`.

Verdict: pass if write endpoints continue to delegate to `WorkflowMutationFacade` and direct orchestrator access remains limited to read endpoints.

### 4. Type Contract Check

Command:

```sh
pnpm run check:types
```

Expected output:

```text
> invoker@0.0.1 check:types
> tsc -p tsconfig.typecheck.json
```

Thresholds:

- Exit code must be `0`.
- No TypeScript diagnostics may be emitted.

Verdict: pass if the selected contract and control-plane boundaries typecheck together.

## Decision

Selected: DB-first orchestrator plus typed IPC registry plus HTTP facade.

Rejected: direct transport-layer mutation.

The selected design wins because its invariants are measurable with deterministic static commands, its write path has one orchestrator refresh/write implementation, and its transport surfaces are either generated from shared contracts or delegated through the mutation facade. The rejected design fails the reviewability threshold because mutation semantics would need to be proven separately for every transport route.
