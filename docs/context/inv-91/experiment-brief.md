# INV-91 Experiment Brief: Retire Deprecated Task Restart/Retry Pathways

**Date:** 2026-05-09
**Status:** Active
**Decision:** Compatibility adapter with deprecation window (Alternative A)

## Problem

Three overlapping verbs (`restart`, `retry`, `recreate`) for task
invalidation span 9 architectural layers across 12+ production files.
The deprecated `restartTask` symbol adds cognitive load and maintenance
burden.

## Done Criteria

1. Zero production call sites reference deprecated `restart` pathways.
2. All package tests pass under both adapter-present and adapter-removed states.
3. Deterministic metrics (M1--M5) reach pass thresholds.
4. Decision gates (G1--G6) all pass before adapter removal.

---

## Deprecated Surface Inventory (Verified 2026-05-09)

### Layer 1: Orchestrator

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `Orchestrator.restartTask()` | `packages/workflow-core/src/orchestrator.ts` | 2020--2026 | Warns, delegates to `recreateTask()` |

### Layer 2: Command Service

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `CommandService.restartTask()` | `packages/workflow-core/src/command-service.ts` | 170--178 | Warns, delegates to `recreateTask()` |

### Layer 3: IPC Channels

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `'invoker:restart-task'` | `packages/contracts/src/ipc-channels.ts` | 273 | UI compat; handler routes to `retryTask()` |
| `'invoker:rebase-and-retry'` | `packages/contracts/src/ipc-channels.ts` | 335 | Legacy name alongside `recreate-with-rebase` |

### Layer 4: HTTP API

| Route | File | Line | Behavior |
|---|---|---|---|
| `POST /api/tasks/:id/restart` | `packages/app/src/api-server.ts` | 213 | Deprecation header, routes to `retryTask()` |
| `POST /api/workflows/:id/restart` | `packages/app/src/api-server.ts` | 320 | Deprecation header, routes to `recreateWorkflow()` |
| `POST /api/workflows/:id/rebase-and-retry` | `packages/app/src/api-server.ts` | 362 | Deprecation header, routes to `recreateWorkflowFromFreshBase()` |

### Layer 5: UI

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `invoker.restartTask(taskId)` | `packages/ui/src/App.tsx` | 201 | Calls deprecated IPC channel |

### Layer 6: Headless CLI

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `case 'rebase-and-retry'` | `packages/app/src/headless.ts` | 1001 | `warnDeprecated`, then delegates |
| `rebase-and-retry` in usage text | `packages/app/src/headless.ts` | 1201 | Deprecated help entry |
| `context: 'headless.rebase-and-retry'` | `packages/app/src/headless.ts` | 1631 | Deprecated context string |

### Layer 7: IPC Delegation Router

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `case 'invoker:restart-task'` | `packages/app/src/main.ts` | 1901 | Legacy-to-canonical map |
| `'invoker:restart-task'` handler | `packages/app/src/main.ts` | 3029 | Routes to `commandService.retryTask` |
| `'invoker:rebase-and-retry'` handler | `packages/app/src/main.ts` | 3245 | Routes to rebase logic |

### Layer 8: Workflow Actions

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `function restartTask()` | `packages/app/src/workflow-actions.ts` | 198 | Compat wrapper |

### Layer 9: Support Files

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `'rebase-and-retry'` | `packages/app/src/headless-command-classification.ts` | 127 | Deprecated command entry |
| `'rebase-and-retry'` and `'restart'` | `packages/app/src/headless-delegation.ts` | 74 | Deprecated timeout classification |
| `'facade.rebase-and-retry'` | `packages/app/src/workflow-mutation-facade.ts` | 252 | Deprecated context string |

### Layer 10: Test Mocks

| Symbol | File | Line | Behavior |
|---|---|---|---|
| `restartTask: vi.fn(...)` | `packages/ui/src/__tests__/helpers/mock-invoker.ts` | 76 | Mock for deprecated symbol |

---

## Existing Guardrails

1. **`restart-deprecation.test.ts`** (workflow-core): verifies shim
   delegates to `recreateTask`, emits warning, zero production
   `.restartTask(` call sites in `workflow-core/src/`.
2. **`lifecycle-matrix.test.ts`**: verifies 5 canonical methods exist +
   shim still exists.
3. **`api-server.test.ts`**: verifies `/restart` routes return
   `deprecated: true`.
4. **`workflow-actions.test.ts`**: verifies no production wrapper calls
   `restartTask`.

---

## Alternatives Evaluated

### Alternative A: Compatibility Adapter Window (Chosen)

Keep deprecated adapters in place. Migrate call sites in deterministic
steps. Remove adapters only after all decision gates pass.

**Pros:**
- Per-step blast radius: 1--2 files.
- Each step independently revertable via `git revert`.
- Runtime crash risk: zero (adapters absorb missed sites).
- Verification per step: pass/fail on each metric.

**Cons:**
- 14 sequential steps vs 1.
- Adapter code remains until gates pass.

### Alternative B: Hard Remove All At Once

Delete all deprecated symbols, channels, routes, and aliases in a
single commit. Update all callers and tests simultaneously.

**Pros:**
- Single step to clean state.
- No adapter maintenance window.

**Cons:**
- Blast radius: 12--13 production files simultaneously.
- All-or-nothing revert.
- Missed call site = runtime crash with no fallback.
- Harder to bisect failures.

---

## Deterministic Evaluation

All commands use `WD` as the worktree root path variable. Set it before
running:

```bash
WD="$(git rev-parse --show-toplevel)"
```

### Metric 1 (M1): Deprecated Symbol Count in Production Code

Counts production references to `restartTask` / `invoker:restart-task`
excluding tests.

**Command:**
```bash
rg -c '\.restartTask\(|invoker:restart-task' \
  --type ts \
  --glob '!**/__tests__/**' \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/*.d.ts' \
  "$WD/packages/" \
  | awk -F: '{s+=$2} END {print s+0}'
```

| State | Expected Output | Pass Threshold |
|---|---|---|
| Baseline (2026-05-09) | 8 | N/A (reference) |
| After Alternative A migration | 0 | `== 0` |
| After Alternative B removal | 0 | `== 0` |

### Metric 2 (M2): Deprecated Route/Alias Count in Production Code

Counts production references to `rebase-and-retry` excluding tests and
`execution-engine/` (which uses the term as an operational concept, not
an API surface).

**Command:**
```bash
rg -c 'rebase-and-retry' \
  --type ts \
  --glob '!**/__tests__/**' \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/execution-engine/**' \
  "$WD/packages/" \
  | awk -F: '{s+=$2} END {print s+0}'
```

| State | Expected Output | Pass Threshold |
|---|---|---|
| Baseline (2026-05-09) | 19 | N/A (reference) |
| After Alternative A migration | 0 | `== 0` |
| After Alternative B removal | 0 | `== 0` |

### Metric 3 (M3): Test Suite Stability

Runs all tests in the three target packages.

**Command:**
```bash
cd "$WD/packages/workflow-core" && pnpm test 2>&1; echo "EXIT:$?"
cd "$WD/packages/contracts" && pnpm test 2>&1; echo "EXIT:$?"
cd "$WD/packages/app" && pnpm test 2>&1; echo "EXIT:$?"
```

| Package | Pass Threshold |
|---|---|
| workflow-core | exit 0, zero failures |
| contracts | exit 0, zero failures |
| app | exit 0, zero failures |

### Metric 4 (M4): Hard-Removal Breakage Candidates

Counts all production references to deprecated API surfaces. Key
differentiator between alternatives: under Alternative B, any non-zero
result after the removal commit represents a runtime crash candidate.

**Command:**
```bash
rg -c '\.restartTask\(|invoker:restart-task|/restart|rebase-and-retry' \
  --type ts \
  --glob '!**/__tests__/**' \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/execution-engine/**' \
  "$WD/packages/" \
  | awk -F: '{s+=$2} END {print s+0}'
```

| State | Expected Output | Pass Threshold |
|---|---|---|
| Baseline (2026-05-09) | 27 | N/A (reference) |
| After Alternative A step 14 | 0 | `== 0` |
| After Alternative B | 0 | `== 0` |

**Interpretation:** Under Alternative B, if this count is > 0 after the
single removal commit, remaining references are runtime crash
candidates. Under Alternative A, each migration step reduces this count
incrementally.

### Metric 5 (M5): TypeScript Compilation

Verifies no type errors from removed symbols.

**Command:**
```bash
cd "$WD/packages/workflow-core" && npx tsc --noEmit 2>&1; echo "EXIT:$?"
cd "$WD/packages/contracts" && npx tsc --noEmit 2>&1; echo "EXIT:$?"
cd "$WD/packages/app" && npx tsc --noEmit 2>&1; echo "EXIT:$?"
```

| State | Expected | Pass Threshold |
|---|---|---|
| All states | exit 0, zero type errors | `exit 0` |

---

## Alternative Proof Evidence

### Hard-Removal Replay Test

This test validates Alternative B risk by toggling hard removal and
measuring breakage.

**Procedure:**
1. Create a temporary branch from current HEAD.
2. Remove all deprecated symbols (simulating Alternative B).
3. Run M1, M2, M4 to verify count reaches 0.
4. Run M3 and M5 to verify tests and compilation pass.
5. Record the breakage count at each step.

**Deterministic command sequence:**
```bash
# Step 1: Branch
git checkout -b inv91-hard-removal-test

# Step 2: Remove all deprecated symbols
# (same file edits as Alternative A steps 1--14 but in one commit)

# Step 3: Run metrics
M1=$(rg -c '\.restartTask\(|invoker:restart-task' \
  --type ts --glob '!**/__tests__/**' --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' --glob '!**/*.d.ts' \
  "$WD/packages/" | awk -F: '{s+=$2} END {print s+0}')
echo "M1=$M1"  # Expected: 0

M4=$(rg -c '\.restartTask\(|invoker:restart-task|/restart|rebase-and-retry' \
  --type ts --glob '!**/__tests__/**' --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' --glob '!**/execution-engine/**' \
  "$WD/packages/" | awk -F: '{s+=$2} END {print s+0}')
echo "M4=$M4"  # Expected: 0

# Step 4: Run tests
cd "$WD/packages/workflow-core" && pnpm test; echo "M3_WC=$?"
cd "$WD/packages/contracts" && pnpm test; echo "M3_CONTRACTS=$?"
cd "$WD/packages/app" && pnpm test; echo "M3_APP=$?"

# Step 5: Cleanup
git checkout - && git branch -D inv91-hard-removal-test
```

**Pass/fail:**
- If all M values are 0 and all tests pass: both alternatives reach the
  same end state.
- If any M > 0 or any test fails: Alternative B has unresolved breakage
  that Alternative A's incremental approach would have caught.

---

## Decision Gates

Adapter removal proceeds ONLY when ALL gates pass.

| Gate | Metric | Threshold | Verification Command |
|---|---|---|---|
| G1 | M1: deprecated symbol count | `== 0` | See M1 command |
| G2 | M2: deprecated route/alias count | `== 0` | See M2 command |
| G3 | M3: test suites pass | `exit 0` all 3 packages | See M3 command |
| G4 | M4: breakage candidates | `== 0` | See M4 command |
| G5 | M5: TypeScript compiles | `exit 0` all 3 packages | See M5 command |
| G6 | Deprecation tests updated | Tests assert symbols GONE | `rg -c 'restartTask.*(not\|toBeUndefined\|GONE)' "$WD/packages/workflow-core/src/__tests__/restart-deprecation.test.ts"` returns > 0 |

---

## Comparison Summary

| Criterion | Alternative A (Adapter) | Alternative B (Hard Remove) |
|---|---|---|
| Blast radius per step | 1--2 files | 12--13 files |
| Revert granularity | Per-step | All-or-nothing |
| Runtime crash risk | Zero | High (missed site = crash) |
| Steps | 14 sequential | 1 |
| Verification | Per-step pass/fail | Single pass/fail |
| Decision gate | Graduated | Binary |

**Verdict:** Alternative A. Lower rollout risk, same end state,
independently verifiable steps. Alternative B is the end state after all
gates pass.

---

## Files Under Test

- `packages/workflow-core/src/orchestrator.ts:2020` -- `restartTask` shim
- `packages/workflow-core/src/command-service.ts:170` -- `restartTask` shim
- `packages/contracts/src/ipc-channels.ts:273` -- `invoker:restart-task` channel
- `packages/contracts/src/ipc-channels.ts:335` -- `invoker:rebase-and-retry` channel
- `packages/app/src/api-server.ts:213` -- `/restart` route (tasks)
- `packages/app/src/api-server.ts:320` -- `/restart` route (workflows)
- `packages/app/src/api-server.ts:362` -- `/rebase-and-retry` route
- `packages/app/src/main.ts:1901` -- IPC delegation case
- `packages/app/src/main.ts:3029` -- `invoker:restart-task` handler
- `packages/app/src/main.ts:3245` -- `invoker:rebase-and-retry` handler
- `packages/app/src/headless.ts:1001` -- `rebase-and-retry` command case
- `packages/app/src/headless-command-classification.ts:127` -- deprecated entry
- `packages/app/src/headless-delegation.ts:74` -- deprecated timeout classification
- `packages/app/src/workflow-actions.ts:198` -- `restartTask` function
- `packages/app/src/workflow-mutation-facade.ts:252` -- `facade.rebase-and-retry`
- `packages/ui/src/App.tsx:201` -- UI call site
