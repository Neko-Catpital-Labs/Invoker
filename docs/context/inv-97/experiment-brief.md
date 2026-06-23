# INV-97 — Experiment Brief: Deterministic Proof for the Launch-Handoff Architecture

**Status:** evidence-backed and reproducible
**Owner:** INV-97
**Last verified:** 2026-06-22

## 1. What we are deciding

When a workflow mutation (edit a task's command/prompt/agent, replace a task, change
a gate policy, or change a merge branch) unblocks new work, **who actually starts that
work?** Two designs were on the table. This brief locks in the chosen one with commands
anyone can re-run to confirm the behavior.

- **Selected approach — Durable Launch Outbox.** The mutation only *records* that a task
  is ready by writing a row to the `task_launch_dispatch` table. A separate poller
  (`LaunchDispatcher`) leases each row and is the single code path that calls
  `TaskRunner.executeTask(...)`. The mutation itself never spawns a worktree.
- **Competing approach — Direct in-process dispatch.** The mutation handler immediately
  (and recursively) calls `taskExecutor.executeTasks(runnable)` inline, spawning the
  worktree before the mutation call returns.

The selected approach was chosen because a single durable launch path removes a whole
class of races and double-launches: every launch is idempotent (one leased row), and a
crash mid-mutation leaves a replayable row instead of a half-started worktree. The
competing approach is simpler to read but spreads the launch trigger across every
mutation handler, and each in-process `TaskRunner` keeps its own
`launchingAttemptIds` set — so two runners cannot see each other's in-flight launches.

## 2. Concrete files under test

| File | Role in the experiment |
| --- | --- |
| `packages/app/src/__tests__/app-layer-handoff-repro.test.ts` | The proof. Drives 7 real mutations and asserts each one *hands off* to the outbox instead of launching in-process. |
| `packages/app/src/global-topup.ts` | The selected-approach implementation. `dispatchTasks()` deliberately **skips** `executeTasks` (see the "launch outbox owns launch" branch, lines 91–101) and `dispatchStartedTasksWithGlobalTopup()` returns `{ runnable, topup }`. |
| `packages/execution-engine/src/task-runner.ts` | The engine side of the contract. `LaunchOutboxAck` (lines ~261–264) plus `executeNewlyStartedTasks()` (lines ~524–536), which returns early when `dispatchOpts` is present — "durable launch outbox owns …; skipping recursive executeTasks". |
| `packages/app/src/headless.ts` | Wires the poller. `dispatchHeadlessRunnableTasks()` (lines ~274–313) builds a `LaunchDispatcher` and polls it; `createHeadlessExecutor()` reuses one owner `TaskRunner`. |
| `packages/execution-engine/src/__tests__/task-runner-launch-dispatch.test.ts` | The engine-level proof that the runner honors the outbox contract (`completeDispatch`/`failDispatch`, no recursive execution). |

## 3. The distinguishing observable

The two designs are told apart by what is true **immediately after a mutation returns,
before any poller runs**:

| Signal | Selected (outbox) | Competing (direct dispatch) |
| --- | --- | --- |
| Task `execution.workspacePath` | **`undefined`** (no worktree spawned yet) | a real worktree path (launched in-process) |
| `dispatchStartedTasksWithGlobalTopup(...).topup` | **`[]`** (no in-process top-up) | non-empty / side-effecting launches |
| `result.runnable` | the unblocked task ids, *recorded only* | the unblocked task ids, *already executing* |
| Task `status` | `running` (claimed, awaiting dispatcher) | `running` (already in executor) |

`app-layer-handoff-repro.test.ts` asserts the **left column** for every mutation, e.g.
`expect(h.getTask('A')!.execution.workspacePath).toBeUndefined()` and
`expect(result.topup).toEqual([])`. If the codebase regressed to the competing design,
`workspacePath` would be set and `topup` would be non-empty, and these assertions fail —
that is the falsifiable line between the two architectures.

The one exception that proves the rule: the **merge-branch** cases
(`set-merge-branch`, `standalone-owner set-merge-branch`) assert
`workspacePath === '/tmp/mock-merge-worktree'`, because a merge node's gate clone is
provisioned by the merge runner, not by the launch handoff. The handoff invariant there
is still `topup === []`.

## 4. Deterministic commands, expected output, verdict

All commands are run from the repo root. Per repo policy they use `pnpm test` (never a
bare `vitest`/`npx`). Each is deterministic — no network, no clock dependence, fixed
in-memory harness — so the pass/fail exit code is the verdict.

### Command A — app-layer handoff proof (primary)

```bash
cd packages/app && pnpm test src/__tests__/app-layer-handoff-repro.test.ts
```

**Expected output (verified 2026-06-22):**

```
 ✓ src/__tests__/app-layer-handoff-repro.test.ts (7 tests)

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

**Verdict:** PASS = the selected outbox handoff holds for all 7 mutation paths
(edit-command, edit-prompt, edit-agent, set-external-gate-policies, replace-task,
set-merge-branch, standalone set-merge-branch). Any failure ⇒ a mutation launched
in-process ⇒ regression toward the competing design.

### Command B — engine-level outbox contract

```bash
cd packages/execution-engine && pnpm test src/__tests__/task-runner-launch-dispatch.test.ts
```

**Expected output (verified 2026-06-22):**

```
 ✓ src/__tests__/task-runner-launch-dispatch.test.ts (10 tests)

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

**Verdict:** PASS = `TaskRunner` honors the outbox ack contract — notably
`does not recursively execute newly-started tasks when launched from the outbox` and
`CD.1: pivot tasks terminate the dispatch row via completeDispatch`. These are the
engine-side guarantees the app-layer test depends on.

## 5. Thresholds

| Metric | Threshold | Why |
| --- | --- | --- |
| Command A test pass count | **7 / 7** | One assertion bundle per supported mutation path; a dropped test silently removes coverage for one handoff. |
| Command B test pass count | **10 / 10** | Engine contract is all-or-nothing; a single failure means a launch can escape the outbox. |
| `result.topup` in every Command A case | **exactly `[]`** | Non-empty top-up ⇒ in-process launch ⇒ competing design. |
| Non-merge `workspacePath` after mutation | **`undefined`** | A set path ⇒ worktree spawned by the mutation, not the dispatcher. |
| Combined wall-clock (both files) | **< 5 s** on a dev laptop (observed ~0.9 s each) | Keeps the proof cheap to re-run in review; a large jump signals accidental real I/O. |

## 6. How to read a failure

- **`workspacePath` is defined where it should be `undefined`** → a mutation handler is
  calling `executeTasks` directly again; check `global-topup.ts:dispatchTasks` hasn't
  been "fixed" to re-enable in-process launch.
- **`topup` non-empty** → `executeGlobalTopup` started work in-process instead of
  recording it; same root cause.
- **Command B `…recursively execute…` test fails** → `executeNewlyStartedTasks` lost its
  early return on `dispatchOpts`, so the engine double-launches alongside the dispatcher.

## 7. Verdict

The selected **Durable Launch Outbox** design is the supported architecture and is
proven by Commands A and B above. The competing **direct in-process dispatch** design is
explicitly rejected: its failure mode is exactly what these tests catch (a populated
`workspacePath` / non-empty `topup` at mutation time). Re-running the two commands is the
deterministic, reviewable evidence for any change that touches the launch path.
