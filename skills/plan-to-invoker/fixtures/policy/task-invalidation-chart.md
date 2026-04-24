# Task Invalidation Policy

This document defines the cleaner model for task invalidation.

The core idea is:

- every execution-spec mutation should map to either `retry` or `recreate`
- and that action should happen at either task scope or workflow scope

That gives us a simple 2x2 model.

## Canonical 2x2 Model

| Scope | Preserve Existing Execution Lineage | Throw Away Existing Execution Lineage |
| --- | --- | --- |
| Task | `retryTask` | `recreateTask` |
| Workflow | `retryWorkflow` | `recreateWorkflow` |

Definitions:

- `retryTask`: rerun one task and invalidate downstream as needed, while preserving valid branch/workspace lineage
- `retryWorkflow`: rerun failed or invalidated work in a workflow, while preserving valid lineage where possible
- `recreateTask`: rerun one task and downstream with fresh branch/workspace/session lineage
- `recreateWorkflow`: rerun the full workflow with fresh branch/workspace/session lineage
- `recreateWorkflowFromFreshBase`: conceptual target action meaning “refresh repo/base state first, then recreate the workflow”

## Hard Invariant

Whenever we `retry` or `recreate`, any affected in-flight work must be interrupted and canceled first.

This applies uniformly to:

- `retryTask`
- `retryWorkflow`
- `recreateTask`
- `recreateWorkflow`

And it applies to any active execution state in the affected scope, including:

- `running`
- `fixing_with_ai`
- merge-node execution
- any future active execution state

## Decision Table

| Mutation | Changes Execution Spec? | Invalidate Active Attempt? | Target Action | Behavior Today | Why |
| --- | --- | --- | --- | --- | --- |
| Edit `command` | Yes | Yes | `recreateTask` | `restartTask` when inactive; special-case task-level interrupt + `restartTask` for `fixing_with_ai`; blocked for normal `running` | A command edit means the task is now materially different, so old execution lineage should be discarded |
| Edit `prompt` | Yes | Yes | `recreateTask` | no dedicated general policy today | A prompt edit changes the task definition, so old execution lineage should be discarded |
| Edit `executionAgent` | Yes | Yes | `recreateTask` | `restartTask` when inactive; blocked when active | Agent choice changes execution behavior enough that old execution lineage should not remain authoritative |
| Edit `executorType` | Yes | Yes | `retryTask` by default | `restartTask` when inactive; blocked when active | Execution environment changed, but workspace lineage may still be valid |
| Edit `remoteTargetId` | Yes | Yes | `recreateTask` | currently piggybacks on `editTaskType()`, so effectively task-level `restartTask` when inactive | Remote host change invalidates existing workspace lineage |
| Edit selected experiment | Yes | Yes if active | `retryTask` for the affected reconciliation result | completes reconciliation task and unblocks downstream; no general active invalidation model | Downstream execution inputs changed |
| Edit selected experiment set | Yes | Yes if active | `retryTask` for the affected reconciliation result | completes reconciliation task and unblocks downstream; no general active invalidation model | Same as above, but for merged lineage |
| Change merge mode | Yes for merge node behavior | Yes if merge node is active | `retryTask` for merge node | restarts merge node only when it is terminal or waiting; no active invalidation path | Merge execution policy changed |
| Change fix prompt or fix context while `fixing_with_ai` | Yes | Yes | `retryTask` from reverted failed state | only command edit has explicit handling today; no general fix-context mutation policy | This is still the same failed task being retried through the fix loop, not a new task topology or substrate |
| Change graph topology | Yes | Not in current workflow | create a new workflow fork from the relevant node | `replaceTask()` mutates graph in place when inactive; blocked when active | Topology changes should not mutate a live workflow in place |
| Retry workflow | No new spec | No | `retryWorkflow` | `retryWorkflow` | This reuses the same spec and retries failed or stuck work |
| Recreate task | No new spec | No | `recreateTask` | `recreateTask` | Explicit user request for fresh state |
| Recreate workflow | No new spec | No | `recreateWorkflow` | `recreateWorkflow` | Explicit user request for fresh workflow state |
| Rebase and retry | Yes at workflow execution base | Yes | `recreateWorkflowFromFreshBase` | today: `preparePoolForRebaseRetry(...)` then `recreateWorkflow()` | Upstream base changed; old lineage is no longer trustworthy |
| Change external gate policy | Usually no | No | no invalidation | unblock only | This changes scheduling policy, not the task execution ABI |
| Approve or reject fix | No | No | continue or revert | continue or revert | This accepts or rejects an already-produced result |

## Route Selection Rule

Choose `retryTask` when:

- the task spec is effectively the same
- we are rerunning the same task after failure, blockage, or fix-state interruption
- the workspace lineage is still valid
- the machine or remote target did not change
- any affected in-flight work can be canceled before retry starts

Choose `recreateTask` when:

- the task identity is the same
- the task execution spec changed materially
- but branch, worktree, machine, or execution substrate lineage should be discarded
- the existing workspace can no longer be trusted
- any affected in-flight work can be canceled before recreate starts

Choose `retryWorkflow` when:

- the workflow spec is unchanged
- failed, blocked, or invalidated work should rerun
- completed work outside the retry scope should be preserved
- any in-flight work inside the affected retry scope will be canceled first

Choose `recreateWorkflow` when:

- the workflow execution base changed
- global workspace lineage is no longer trustworthy
- the user explicitly asked for a fresh workflow reset
- any in-flight work inside the affected workflow scope will be canceled first

Choose `recreateWorkflowFromFreshBase` when:

- the workflow should be recreated from refreshed upstream repo/base state
- the pool mirror or managed branches may contain stale lineage
- origin base refs must be refreshed before rerun
- any in-flight work inside the affected workflow scope will be canceled first

Create a new workflow fork when:

- the graph topology changes
- task identities or dependencies would change
- the desired behavior is “continue from this node with a different graph”

## Execution-Defining Inputs

These should be treated as part of the task execution ABI:

- `command`
- `prompt`
- `executionAgent`
- `executorType`
- `remoteTargetId`
- selected experiment or merged experiment lineage
- merge mode for merge execution
- fix prompt or fix context during fix sessions

These are not execution-defining task inputs:

- external gate policy
- approval or rejection of a finished fix
- explicit lifecycle commands like retry or recreate

## Inconsistencies With The 2x2 Model

### Naming inconsistency

- there is `restartTask()`, not `retryTask()`

### Active-task inconsistency

- inactive task edits already map to task-scoped retry-like behavior even when they should now be recreate-class edits

### Remote target inconsistency

- `remoteTargetId` is currently edited through `editTaskType()`

### Repo/base invalidation inconsistency

- `rebaseAndRetry()` already behaves like a stronger form of workflow recreate

### Merge-mode inconsistency

- merge mode changes already cause merge-node reruns in some cases

### Experiment-lineage inconsistency

- selecting experiments changes downstream execution lineage

### Fix-session inconsistency

- `fixing_with_ai` has bespoke rollback semantics via `beginConflictResolution()` and `revertConflictResolution()`

### Scope inconsistency

- `retryWorkflow` exists

### Topology inconsistency

- `replaceTask()` exists and mutates the graph in place
