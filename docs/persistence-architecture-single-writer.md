# Persistence Architecture: Single-Writer Owner Boundary

## Problem

The Invoker persistence layer (SQLiteAdapter, backed by `node:sqlite`) stores state in a WAL-mode SQLite database. Multiple processes opening the same file in writable mode lead to lost writes when their buffers overwrite each other's changes.

## Solution

**Single-writer owner model**: exactly one process owns writable access to the database. All other processes delegate mutations via IPC or open the database in read-only mode.

## Update: Read-Only Viewers & Exclusive Locking

The owner boundary covers writes. Normal WAL mode allows the writable owner and read-only viewers to open `invoker.db` concurrently.

- **GUI viewer** opens `invoker.db` read-only when the file exists; its renderer still reads only through Electron IPC, and live updates arrive via `TASK_DELTA` / `TASK_OUTPUT`.
- **Read-only headless commands** delegate to the owner over IPC (`headless.query` `cli-query`) when an owner is present, and open the file directly only when none is. In that fallback path they remain read-only callers that may coexist with other readers; this does not imply exclusive ownership.
- **Exclusive locking is opt-in** with `INVOKER_ENABLE_EXCLUSIVE_LOCKING=1`. It keeps the wal-index in heap so no `-shm` file exists, but it is incompatible with delegated read-only viewers because the owner must be the sole opener. `INVOKER_DISABLE_EXCLUSIVE_LOCKING=1` still wins if both variables are set.

## Owner Boundary Contract

### Acceptance Rules

1. **Owner process**: GUI process (main.ts) or standalone headless owner process. A standalone-enabled mutation may become a local writable owner only after it cannot reach a compatible owner and there is no live writable-owner marker.
2. **GUI viewer** opens the shared database read-only when it exists. `openMainProcessDatabase({ detachedViewer: true })` falls back to process-local placeholder persistence only before `invoker.db` has been created.
3. **Non-owner processes**: headless CLI invocations (when GUI is running).
4. **Non-owner processes CANNOT initialize writable persistence**. Attempting to do so throws or delegates.
5. **All non-owner mutations MUST traverse RPC** (`headless.run`, `headless.resume`, `headless.exec` channels via IpcBus). `owner-serve` is the local owner bootstrap command and is exempt from delegation so it cannot delegate to itself.

Implementation note: the missing-file placeholder is SQLite ephemeral storage via `SQLiteAdapter.createEphemeral()`. The raw SQLite `:memory:` sentinel is private to the data-store adapter so viewer startup code cannot accidentally create `invoker.db`.

### Implementation Map

This table lists every mutating command path and how the owner-boundary contract is enforced.

| Command Path | Entry Point | Delegates? | Write Enforcement | Notes |
|--------------|-------------|------------|-------------------|-------|
| **GUI IPC Handlers** (owner process) |
| `invoker:load-plan` | main.ts:744 | N/A (owner) | `initServices()` opens writable DB | GUI always owns DB |
| `invoker:start` | main.ts:770 | N/A (owner) | Orchestrator mutates via owner's persistence | |
| `invoker:approve` | main.ts:966 | N/A (owner) | `orchestrator.approve()` → persistence writes | |
| `invoker:reject` | main.ts:984 | N/A (owner) | `rejectTask()` → orchestrator → persistence | |
| `invoker:select-experiment` | main.ts:988 | N/A (owner) | `sharedSelectExperiments()` → persistence | |
| `invoker:retry-task` | gui-mutation-handlers.ts:894 | N/A (owner) | `commandService.retryTask()` → persistence | |
| `invoker:cancel-task` | main.ts:1019 | N/A (owner) | `performCancelTask()` → orchestrator → persistence | |
| `invoker:cancel-workflow` | main.ts:1029 | N/A (owner) | `performCancelWorkflow()` → orchestrator → persistence | |
| `invoker:recreate-workflow` | main.ts:1043 | N/A (owner) | `sharedRecreateWorkflow()` → persistence bump + orchestrator | |
| `invoker:recreate-task` | main.ts:1060 | N/A (owner) | `sharedRecreateTask()` → persistence | |
| `invoker:retry-workflow` | main.ts:1077 | N/A (owner) | `sharedRetryWorkflow()` → orchestrator | |
| `invoker:rebase-recreate` | gui-mutation-handlers.ts:2060 | N/A (owner) | `rebaseRecreate()` → persistence + orchestrator | Fresh-base workflow recreation |
| `invoker:set-workflow-merge-mode` | gui-mutation-handlers.ts:2276 | N/A (owner) | `setWorkflowMergeMode()` → persistence.updateWorkflow | |
| `invoker:approve-merge` | main.ts:1147 | N/A (owner) | `orchestrator.approve()` → persistence | |
| `invoker:resolve-conflict` | main.ts:1182 | N/A (owner) | `resolveConflictAction()` → persistence + orchestrator | |
| `invoker:fix-with-agent` | main.ts:1196 | N/A (owner) | `orchestrator.beginConflictResolution()` → persistence | |
| `invoker:edit-task-command` | main.ts:1213 | N/A (owner) | `orchestrator.editTaskCommand()` → persistence | |
| `invoker:edit-task-type` | main.ts:1225 | N/A (owner) | `orchestrator.editTaskType()` → persistence | |
| `invoker:edit-task-agent` | main.ts:1237 | N/A (owner) | `sharedEditTaskAgent()` → orchestrator → persistence | |
| `invoker:replace-task` | main.ts:1257 | N/A (owner) | `orchestrator.replaceTask()` → persistence | |
| `invoker:delete-workflow` | main.ts:867 | N/A (owner) | `orchestrator.deleteWorkflow()` → persistence | |
| `invoker:delete-all-workflows` | main.ts:856 | N/A (owner) | `orchestrator.deleteAllWorkflows()` → persistence | |
| **Headless Commands** (owner-first, including when `INVOKER_HEADLESS_STANDALONE=1`; `owner-serve` remains local) |
| `run` | headless.ts:565 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateRun()` → IPC `headless.run` when a compatible owner is reachable; otherwise local writable fallback only when no live writable-owner marker exists | Delegation timeout = 5s |
| `resume` | headless.ts:620 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateResume()` → IPC `headless.resume` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `retry-task` | headless.ts:273 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` → IPC `headless.exec` when a compatible owner is reachable; otherwise marker-gated local writable fallback | Task-scoped retry uses the default 5s delegation timeout |
| `recreate` | headless.ts:769 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `recreate-task` | headless.ts:788 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `rebase-retry` / `rebase-recreate` | headless.ts:296 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | Workflow-scoped fresh-base commands delegate with a 60s timeout; task-scoped fresh-base commands stay at 5s |
| `approve` | headless.ts:666 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `reject` | headless.ts:681 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `input` | headless.ts:688 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `select` | headless.ts:695 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `fix` | headless.ts:722 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `resolve-conflict` | headless.ts:742 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `cancel` | headless.ts:967 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `cancel-workflow` | headless.ts:978 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `delete` | headless.ts:1005 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `delete-all` | headless.ts:434 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `set command` | headless.ts:829 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `set executor` | headless.ts:841 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `set agent` | headless.ts:853 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | |
| `set merge-mode` | headless.ts:1011 | **Yes** (`headless-client.ts:827-839`, `main.ts:996-1020`) | `tryDelegateExec()` when a compatible owner is reachable; otherwise marker-gated local writable fallback | Allowed modes: `manual | automatic | external_review` |
| **Headless Read-Only Commands** | | | | delegate to the owner when present; open `readOnly` only when none |
| `query workflows` | headless.ts:193 | **Yes** (cli-query) | Owner answers over IPC, else opens `readOnly: true` | Safe: no writes |
| `query tasks` | headless.ts:206 | **Yes** (cli-query) | Owner answers over IPC, else opens `readOnly: true` | Safe: no writes |
| `query task` | headless.ts:257 | **Yes** (cli-query) | Owner answers over IPC, else opens `readOnly: true` | Safe: no writes |
| `query queue` | headless.ts:272 | **Yes** (owner-required) | Owner answers over IPC | Live scheduler state; requires an owner |
| `query audit` | headless.ts:295 | **Yes** (cli-query) | Owner answers over IPC, else opens `readOnly: true` | Safe: no writes |
| `query session` | headless.ts:308 | **Yes** (cli-query) | Owner answers over IPC, else opens `readOnly: true` | Safe: no writes |
| **Workflow Mutation Facade / Actions** (shared owner-side mutation layer) |
| `rejectTask()` | workflow-actions.ts:233 | N/A | Called by owner (GUI/headless standalone) → orchestrator → persistence | Shared library assumes writable context |
| `retryTask()` | workflow-mutation-facade.ts:167 / command-service.ts:153 | N/A | Owner facade → `CommandService.retryTask()` → `Orchestrator.retryTask()` → persistence | Lineage-preserving task retry |
| `retryWorkflow()` | workflow-mutation-facade.ts:311 / command-service.ts:487 | N/A | Owner facade → `CommandService.retryWorkflow()` → orchestrator → persistence | |
| `recreateWorkflow()` | workflow-mutation-facade.ts:319 / command-service.ts:510 | N/A | Owner facade → `CommandService.recreateWorkflow()` → orchestrator → persistence | |
| `recreateTask()` | workflow-mutation-facade.ts:175 / command-service.ts:169 | N/A | Owner facade → `CommandService.recreateTask()` → orchestrator → persistence | |
| `cancelWorkflow()` | workflow-actions.ts:360 | N/A | Called by owner → orchestrator → persistence | |
| `recreateWorkflowFromFreshBase()` | workflow-actions.ts:571 / command-service.ts:533 | N/A | Called by owner → fresh-base prep → `CommandService.recreateWorkflowFromFreshBase()` → persistence | Fresh-base workflow recreation |
| `rebaseRetry()` / `rebaseRecreate()` | workflow-actions.ts:583, 610 | N/A | Owner-side helpers resolve the target and route to `retryWorkflow()` / `recreateWorkflowFromFreshBase()` | Canonical fresh-base helper names |
| `editTaskCommand()` | workflow-actions.ts:661 | N/A | Called by owner → orchestrator → persistence | |
| `editTaskType()` | workflow-actions.ts:677 | N/A | Called by owner → orchestrator → persistence | |
| `editTaskAgent()` | workflow-actions.ts:687 | N/A | Called by owner → orchestrator → persistence | |
| `selectExperiment()` | workflow-actions.ts:711 | N/A | Called by owner → orchestrator → persistence | |
| `setWorkflowMergeMode()` | workflow-actions.ts:780 | N/A | Called by owner → persistence.updateWorkflow | Allowed modes: `manual | automatic | external_review` |
| `resolveConflictAction()` | workflow-actions.ts:831 | N/A | Called by owner → orchestrator → persistence | |

### Enforcement Locations

| Component | File | Line(s) | Enforcement Mechanism |
|-----------|------|---------|----------------------|
| **GUI main process** | packages/app/src/main.ts | 743-760 | `initServices()` opens writable DB (no `readOnly` flag) |
| **Headless delegation** | packages/app/src/headless-client.ts, packages/app/src/main.ts, packages/app/src/headless-delegation.ts | 160-188 / 704-765 / 827-839; 925-971 / 996-1020; 68-145 | `tryDelegateRun()`, `tryDelegateResume()`, `tryDelegateExec()` send IPC requests to a compatible owner before writable fallback. Standalone-enabled mutations use the same owner-first rule and fail closed if a live writable-owner marker exists but no compatible owner can be reached. |
| **Headless standalone** | packages/app/src/headless-client.ts, packages/app/src/main.ts | 827-839; 981-982 / 996-1020 / 1150-1155 | `INVOKER_HEADLESS_STANDALONE=1` permits local writable execution only after existing-owner delegation fails and `hasLiveWritableOwnerMarker()` is false; `owner-serve` stays local and opens the writable owner. |
| **SQLiteAdapter read-only gate** | packages/persistence/src/sqlite-adapter.ts | 113-117 | `ensureWritable()` throws if `readOnly: true` and a write is attempted |
| **Delegation handlers (owner)** | packages/app/src/main.ts | 1873-1978 | `headless.run`, `headless.resume`, `headless.exec` IPC handlers receive delegated commands, execute via owner's writable orchestrator/persistence |

### Critical Guarantees

1. **GUI always owns DB**: When GUI is running, `initServices()` (main.ts:743) opens writable persistence. All IPC handlers mutate via this owner instance.
2. **Headless delegates by default**: When GUI or a standalone owner is present, headless mutations try delegation first. `run`, `resume`, and most `headless.exec` commands use a 5s timeout; workflow-scoped `rebase-retry` and `rebase-recreate` use 60s.
3. **Read-only commands never write**: `query` subcommands delegate reads to the owner when one is present; otherwise they open `readOnly: true` persistence.
4. **Standalone is owner-first, not a bypass**: `INVOKER_HEADLESS_STANDALONE=1` first routes mutating commands to a compatible reachable owner. Local writable fallback is allowed only when no compatible owner responds and `hasLiveWritableOwnerMarker()` is false. If a live writable-owner marker exists but IPC cannot reach a compatible owner, the command exits non-zero and refuses writable fallback.
5. **`owner-serve` cannot delegate to itself**: `owner-serve` remains local owner startup. Delegation guards exclude it in both `headless-client.ts` and `main.ts`.
6. **Delegation timeout prevents deadlock**: IPC delegation is bounded so headless does not hang if the owner is unresponsive. The default is 5s, with a 60s allowance for workflow-scoped `rebase-retry` and `rebase-recreate` command shapes in `headless.exec`.

### Test Coverage

- **Concurrent write safety**: Run GUI + headless concurrently (`pnpm test packages/app` includes `concurrent-writes.test.ts` if present).
- **Delegation flow**: Verify `tryDelegateRun()`, `tryDelegateResume()`, and `tryDelegateExec()` route standalone-enabled mutations to a reachable compatible owner, allow local fallback only without a live owner marker, fail closed when a live marker is present but IPC is unavailable, and leave `owner-serve` local.
- **Read-only enforcement**: Attempt write on `readOnly: true` adapter, expect throw.
- **Historical failure-mode repro**: `bash scripts/repro/repro-sqljs-last-writer-wins.sh` demonstrates last-writer-wins when two writable adapters bypass the owner boundary.

### CI Policy Checks

- **Static owner-boundary guard**: `bash scripts/check-owner-boundary.sh` fails if:
  - a non-test runtime module calls `SQLiteAdapter.create(...)` outside owner modules,
  - a non-test runtime module value-imports `SQLiteAdapter` outside owner modules,
  - runtime code opens raw SQLite `:memory:` instead of `SQLiteAdapter.createEphemeral()` or the viewer boundary,
  - `main.ts` stops opening persistence through `openMainProcessDatabase()`.
- **Included in required `test:all`** via `scripts/test-suites/required/15-owner-boundary-policy.sh`.

### Future Work

- **Lock-free reads**: normal WAL mode supports one writer with concurrent read-only viewers. If a long-lived read-only process needs a newer snapshot than its current connection can see, it may need to refresh from the DB.
- **Leader election**: If multiple GUI instances are allowed (not currently), use file lock or PID file to elect single writer.
