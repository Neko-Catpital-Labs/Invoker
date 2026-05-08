# Bulk Delete-All: Design Rationale and Release Notes

## Problem

The "Delete Workflow History" UI action triggers `deleteAllWorkflows()`, which publishes a `removed` TaskDelta for every task before returning. Each delta fires a React state update in the renderer. With N tasks, the UI processes N sequential map-copy operations on its task collection, producing O(N^2) total work. At scale (hundreds of tasks), this causes observable UI freezes.

## Root Cause

`Orchestrator.deleteAllWorkflows()` collects all tasks, purges the DB, clears the scheduler and in-memory state, then iterates every collected task to publish individual `removed` deltas via the message bus. The renderer subscribes to these deltas and performs a state update (immutable map copy) per delta. The quadratic cost comes from N deltas x O(N) state size per update.

```
orchestrator.deleteAllWorkflows()
  → collects allTasks (N tasks)
  → purges DB, scheduler, memory
  → for each task: publish removed delta   ← N messages
      → renderer receives delta
      → renderer copies task map (size N)  ← O(N) per message
  → total: O(N²) UI work
```

## Solution: Bulk Delete-All with Suppressed Deltas

A new `invoker:delete-all-workflows-bulk` IPC channel routes through a dedicated code path that passes `{ publishRemovalDeltas: false }` to the orchestrator. The orchestrator skips per-task delta publication. The main process sends a single `invoker:workflows-changed` event instead, and the UI calls `clearTasks()` to reset state in O(1).

### Architecture (layered bottom-up)

| Layer | Package | Change |
|-------|---------|--------|
| Contract | `packages/contracts` | New `invoker:delete-all-workflows-bulk` channel (`request: [], response: void`) |
| Domain | `packages/workflow-core` | `deleteAllWorkflows(options?)` accepts `{ publishRemovalDeltas?: boolean }`. Default `true` preserves legacy behavior. When `false`, skips `getAllTasks()` collection and delta loop entirely. |
| App bridge | `packages/app` | New `deleteAllWorkflowsBulk()` action in `workflow-actions.ts`. Same lifecycle as legacy (snapshot → kill active → orchestrator purge) but passes suppression flag. |
| IPC handler | `packages/app/main.ts` | Registered `invoker:delete-all-workflows-bulk` handler. After purge, sends `invoker:workflows-changed` with empty array. |
| Coordinator | `packages/app` | `PersistedWorkflowMutationCoordinator` classifies bulk channel as `delete` fence, matching legacy preemption/eviction semantics. |
| UI | `packages/ui` | `App.tsx` calls `invoker.deleteAllWorkflowsBulk()` instead of `invoker.deleteAllWorkflows()`. |

### Why this design

1. **No legacy breakage.** The original `deleteAllWorkflows()` path is untouched. Headless and programmatic callers keep existing behavior.
2. **Minimal surface.** One new IPC channel, one new app action, one orchestrator option. No new state, no new persistence schema.
3. **Explicit opt-in.** Bulk semantics require calling the bulk endpoint. No ambient behavior changes.
4. **Fence parity.** The coordinator treats bulk delete identically to legacy delete for queue invalidation and preemption. No race conditions introduced.

### Alternatives considered

- **Renderer-side batching:** Batch deltas in the UI and apply once. Rejected because the main process still does O(N) IPC sends, and batching adds UI complexity without fixing the source.
- **Mutate existing channel with a bulk flag:** Rejected because it creates implicit branching in existing handlers and makes behavior harder to audit.
- **Post-publication suppression in app layer:** Rejected because it doesn't remove the core overhead — the orchestrator still collects all tasks and iterates.

## Files Changed (14 files, +474 / -9 lines)

### Production code
- `packages/contracts/src/ipc-channels.ts` — new `invoker:delete-all-workflows-bulk` channel
- `packages/workflow-core/src/orchestrator.ts` — `DeleteAllWorkflowsOptions` type, conditional delta suppression
- `packages/app/src/workflow-actions.ts` — `deleteAllWorkflowsBulk()` action
- `packages/app/src/main.ts` — IPC handler registration + headless routing
- `packages/app/src/persisted-workflow-mutation-coordinator.ts` — delete-fence classification
- `packages/ui/src/App.tsx` — callsite switch to bulk method

### Tests
- `packages/workflow-core/src/__tests__/orchestrator.test.ts` — legacy vs bulk delta assertions
- `packages/app/src/__tests__/delete-all-lifecycle.test.ts` — app bridge lifecycle coverage
- `packages/app/src/__tests__/persisted-workflow-mutation-coordinator.test.ts` — fence classification
- `packages/ui/src/__tests__/delete-history-repro.test.ts` — UI delete reproduction
- `packages/ui/src/__tests__/app-launch.test.tsx` — mock type coverage
- `packages/ui/src/__tests__/helpers/mock-invoker.ts` — mock surface update

### Scripts
- `scripts/run-all-tests.sh` — test runner adjustments
- `submit-plan.sh` — plan submission adjustments

## Operational Guidance

### For reviewers

1. Verify the legacy `invoker:delete-all-workflows` path is untouched by checking that `deleteAllWorkflows()` (no options) still publishes deltas.
2. Confirm the coordinator fence classification includes the bulk channel in both the `classifyMutationType` and `isPreemptive` predicates.
3. Check that the headless routing maps `invoker:delete-all-workflows-bulk` to `delete-all` args, matching legacy headless behavior.

### For maintainers

- If adding new delete-like channels, update the coordinator's `classifyMutationType` and `isPreemptive` checks.
- The `publishRemovalDeltas` option is domain-level. New callers that want silent bulk delete should use `{ publishRemovalDeltas: false }` and handle UI notification separately.
- The legacy path remains the default. Removing the bulk path only requires deleting the bulk channel, action, handler, and reverting the UI callsite.

### Revert plan

Revert the UI callsite in `App.tsx` back to `invoker.deleteAllWorkflows()`. The remaining bulk infrastructure is additive and inert without callers. Full cleanup can follow separately.

## PR Publication

Invoker PR publication should use **Mergify Stacks** (`mergify stack push`) once workflow commits are ready. This preserves the stacked branch structure and enables incremental review of each workflow layer.
