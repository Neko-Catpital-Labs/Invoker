# Persistence Architecture: Single-Writer Owner Boundary

## Problem

The Invoker persistence layer (SQLiteAdapter) is backed by sql.js (WASM SQLite), which flushes in-memory changes to disk asynchronously. Multiple processes opening the same database file in writable mode leads to lost writes when processes flush stale buffers over each other's changes.

## Solution

**Single-writer owner model**: exactly one process owns writable access to the database. All other processes delegate mutations via IPC or open the database in read-only mode.

## Owner Boundary Contract

### Acceptance Rules

1. **Owner process**: GUI process (main.ts) or standalone headless process (when `INVOKER_HEADLESS_STANDALONE=1`).
2. **Non-owner processes**: headless CLI invocations (when GUI is running).
3. **Non-owner processes CANNOT initialize writable persistence**. Attempting to do so throws or delegates.
4. **All non-owner mutations MUST traverse RPC** (`headless.run`, `headless.resume`, `headless.exec` channels via IpcBus).

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
| `invoker:restart-task` | main.ts:1000 | N/A (owner) | `orchestrator.restartTask()` → persistence | |
| `invoker:cancel-task` | main.ts:1019 | N/A (owner) | `performCancelTask()` → orchestrator → persistence | |
| `invoker:cancel-workflow` | main.ts:1029 | N/A (owner) | `performCancelWorkflow()` → orchestrator → persistence | |
| `invoker:recreate-workflow` | main.ts:1043 | N/A (owner) | `sharedRecreateWorkflow()` → persistence bump + orchestrator | |
| `invoker:recreate-task` | main.ts:1060 | N/A (owner) | `sharedRecreateTask()` → persistence | |
| `invoker:retry-workflow` | main.ts:1077 | N/A (owner) | `sharedRetryWorkflow()` → orchestrator | |
| `invoker:rebase-and-retry` | main.ts:1094 | N/A (owner) | `rebaseAndRetry()` → persistence + orchestrator | |
| `invoker:set-merge-mode` | main.ts:1129 | N/A (owner) | `setWorkflowMergeMode()` → persistence.updateWorkflow | |
| `invoker:approve-merge` | main.ts:1147 | N/A (owner) | `orchestrator.approve()` → persistence | |
| `invoker:resolve-conflict` | main.ts:1182 | N/A (owner) | `resolveConflictAction()` → persistence + orchestrator | |
| `invoker:fix-with-agent` | main.ts:1196 | N/A (owner) | `orchestrator.beginConflictResolution()` → persistence | |
| `invoker:edit-task-command` | main.ts:1213 | N/A (owner) | `orchestrator.editTaskCommand()` → persistence | |
| `invoker:edit-task-type` | main.ts:1225 | N/A (owner) | `orchestrator.editTaskType()` → persistence | |
| `invoker:edit-task-agent` | main.ts:1237 | N/A (owner) | `sharedEditTaskAgent()` → orchestrator → persistence | |
| `invoker:replace-task` | main.ts:1257 | N/A (owner) | `orchestrator.replaceTask()` → persistence | |
| `invoker:delete-workflow` | main.ts:867 | N/A (owner) | `orchestrator.deleteWorkflow()` → persistence | |
| `invoker:delete-all-workflows` | main.ts:856 | N/A (owner) | `orchestrator.deleteAllWorkflows()` → persistence | |
| **Headless Commands** (delegate when GUI present, standalone otherwise) |
| `run` | headless.ts:565 | **Yes** (line 356) | `tryDelegateRun()` → IPC `headless.run` (owner handles) OR standalone opens writable via `initServices({ readOnly: false })` | Delegation timeout = 5s |
| `resume` | headless.ts:620 | **Yes** (line 361) | `tryDelegateResume()` → IPC `headless.resume` OR standalone writable | |
| `restart` | headless.ts:707 | **Yes** (line 365) | `tryDelegateExec()` → IPC `headless.exec` OR standalone writable | Workflow-scoped `restart wf-…` delegates with a 60s timeout; task-scoped restart stays at 5s |
| `recreate` | headless.ts:769 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `recreate-task` | headless.ts:788 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `rebase` | headless.ts:754 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | Workflow-scoped `rebase wf-…` and deprecated `rebase-and-retry wf-…` delegates use a 60s timeout; task-scoped rebase stays at 5s |
| `approve` | headless.ts:666 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `reject` | headless.ts:681 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `input` | headless.ts:688 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `select` | headless.ts:695 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `fix` | headless.ts:722 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `resolve-conflict` | headless.ts:742 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `cancel` | headless.ts:967 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `cancel-workflow` | headless.ts:978 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `delete` | headless.ts:1005 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `delete-all` | headless.ts:434 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `set command` | headless.ts:829 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `set executor` | headless.ts:841 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `set agent` | headless.ts:853 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| `set merge-mode` | headless.ts:1011 | **Yes** (line 365) | `tryDelegateExec()` OR standalone writable | |
| **Headless Read-Only Commands** (never delegate, always read-only) |
| `query workflows` | headless.ts:193 | No | Opens DB with `readOnly: true` (main.ts:386) | Safe: no writes |
| `query tasks` | headless.ts:206 | No | Opens DB with `readOnly: true` | Safe: no writes |
| `query task` | headless.ts:257 | No | Opens DB with `readOnly: true` | Safe: no writes |
| `query queue` | headless.ts:272 | No | Opens DB with `readOnly: true` | Safe: no writes |
| `query audit` | headless.ts:295 | No | Opens DB with `readOnly: true` | Safe: no writes |
| `query session` | headless.ts:308 | No | Opens DB with `readOnly: true` | Safe: no writes |
| **Workflow Actions** (shared library, always called by owner) |
| `rejectTask()` | workflow-actions.ts:54 | N/A | Called by owner (GUI/headless standalone) → orchestrator → persistence | Shared library assumes writable context |
| `restartTask()` | workflow-actions.ts:75 | N/A | Called by owner → orchestrator → persistence | |
| `retryWorkflow()` | workflow-actions.ts:82 | N/A | Called by owner → orchestrator → persistence | |
| `recreateWorkflow()` | workflow-actions.ts:89 | N/A | Called by owner → `bumpGenerationAndRecreate()` → persistence | |
| `recreateTask()` | workflow-actions.ts:96 | N/A | Called by owner → orchestrator → persistence | |
| `cancelWorkflow()` | workflow-actions.ts:103 | N/A | Called by owner → orchestrator → persistence | |
| `rebaseAndRetry()` | workflow-actions.ts:117 | N/A | Called by owner → `bumpGenerationAndRecreate()` → persistence | |
| `editTaskCommand()` | workflow-actions.ts:136 | N/A | Called by owner → orchestrator → persistence | |
| `editTaskType()` | workflow-actions.ts:144 | N/A | Called by owner → orchestrator → persistence | |
| `editTaskAgent()` | workflow-actions.ts:153 | N/A | Called by owner → orchestrator → persistence | |
| `selectExperiment()` | workflow-actions.ts:161 | N/A | Called by owner → orchestrator → persistence | |
| `setWorkflowMergeMode()` | workflow-actions.ts:189 | N/A | Called by owner → persistence.updateWorkflow | |
| `resolveConflictAction()` | workflow-actions.ts:208 | N/A | Called by owner → orchestrator → persistence | |

### Enforcement Locations

| Component | File | Line(s) | Enforcement Mechanism |
|-----------|------|---------|----------------------|
| **GUI main process** | packages/app/src/main.ts | 605-613 | `initServices()` opens writable DB (no `readOnly` flag) |
| **Headless delegation** | packages/app/src/main.ts, packages/app/src/headless-delegation.ts | 346-381, 14-65 | `tryDelegateRun()`, `tryDelegateResume()`, `tryDelegateExec()` send IPC request to owner; `run`, `resume`, and default `exec` delegation use 5s timeout, while workflow-scoped `rebase` / `rebase-and-retry` / `restart` use 60s before standalone fallback |
| **Headless standalone** | packages/app/src/main.ts | 386 | `initServices({ readOnly: isHeadlessReadOnlyCommand(cliArgs) })` — read-only for query commands, writable for standalone mutating commands (when `INVOKER_HEADLESS_STANDALONE=1` or no GUI) |
| **SQLiteAdapter read-only gate** | packages/persistence/src/sqlite-adapter.ts | 113-117 | `ensureWritable()` throws if `readOnly: true` and a write is attempted |
| **Delegation handlers (owner)** | packages/app/src/main.ts | 618-674 | `headless.run`, `headless.resume`, `headless.exec` IPC handlers receive delegated commands, execute via owner's writable orchestrator/persistence |

### Critical Guarantees

1. **GUI always owns DB**: When GUI is running, `initServices()` (main.ts:605) opens writable persistence. All IPC handlers mutate via this owner instance.
2. **Headless delegates by default**: When GUI is present, headless commands try delegation first. `run`, `resume`, and most `headless.exec` commands use a 5s timeout; workflow-scoped `rebase`, `rebase-and-retry`, and `restart` use 60s. Only if delegation fails (no GUI or timeout) does headless open its own writable DB.
3. **Read-only commands never delegate**: `query` subcommands always open `readOnly: true` persistence (main.ts:386), never write.
4. **Standalone escape hatch**: `INVOKER_HEADLESS_STANDALONE=1` skips delegation, allowing headless to own the DB (main.ts:348-349).
5. **Delegation timeout prevents deadlock**: IPC delegation is bounded so headless does not hang if GUI is unresponsive. The default is 5s, with a 60s allowance for workflow-scoped `rebase`, `rebase-and-retry`, and `restart` command shapes in `headless.exec`.

### Test Coverage

- **Concurrent write safety**: Run GUI + headless concurrently (`pnpm test packages/app` includes `concurrent-writes.test.ts` if present).
- **Delegation flow**: Verify `tryDelegateRun()` succeeds when GUI is running, falls back to standalone when GUI is not running.
- **Read-only enforcement**: Attempt write on `readOnly: true` adapter, expect throw.
- **Historical failure-mode repro**: `bash scripts/repro/repro-sqljs-last-writer-wins.sh` demonstrates last-writer-wins when two writable adapters bypass the owner boundary.

### CI Policy Checks

- **Static owner-boundary guard**: `bash scripts/check-owner-boundary.sh` fails if:
  - a non-test runtime module calls `SQLiteAdapter.create(...)` outside owner modules,
  - a non-test runtime module value-imports `SQLiteAdapter` outside owner modules,
  - owner init path in `main.ts` stops passing `ownerCapability: !readOnly`.
- **Included in required `test:all`** via `scripts/test-suites/required/15-owner-boundary-policy.sh`.

### Future Work

- **Lock-free reads**: sql.js doesn't support multi-reader MVCC. If read-only processes need fresher data, they must re-open the DB (current behavior: query commands open fresh each time).
- **Leader election**: If multiple GUI instances are allowed (not currently), use file lock or PID file to elect single writer.
