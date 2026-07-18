/**
 * Extracted cancellation domain.
 *
 * These functions implement the cancel primitives (`cancelTask`,
 * `cancelWorkflow`, `deferTask`) and the cancel-first invariant helpers
 * (`cancelActiveBeforeInvalidation`, `cancelActiveCandidates`) as standalone
 * functions operating on a `CancellationHost`. The Orchestrator delegates to
 * them, keeping the methods on the class for API compatibility (see
 * `transitions.ts` for the same host-delegation pattern).
 *
 * Behavior is intentionally identical to the previous in-class methods: the
 * cancel-first ordering (cancel before invalidation reset), scheduler-slot /
 * deferred-set clearing, attempt dual-writes, event names, delta publication,
 * and the post-cancel `checkWorkflowCompletion` are preserved exactly.
 * `deferredTaskIds` remains an Orchestrator field surfaced readonly on the
 * host per the `TransitionHost` precedent.
 */

import type { TaskState, TaskDelta, TaskStateChanges, TaskStatus, Attempt } from '@invoker/workflow-graph';
import { getTransitiveDependents } from '@invoker/workflow-graph';
import { OrchestratorError } from '../orchestrator.js';
import type {
  OrchestratorPersistence,
  OrchestratorMessageBus,
} from '../orchestrator.js';
import type { TaskStateMachine } from '../state-machine.js';
import { buildTaskResetChanges, type TaskResetKind } from '../task-reset-policy.js';

const TASK_DELTA_CHANNEL = 'task.delta';

function isActiveForInvalidation(status: TaskStatus): boolean {
  return (
    status === 'running' ||
    status === 'fixing_with_ai' ||
    status === 'awaiting_approval' ||
    status === 'review_ready'
  );
}

// ── Host Interface ──────────────────────────────────────────

/**
 * Subset of Orchestrator that the cancellation functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface CancellationHost {
  readonly stateMachine: TaskStateMachine;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly deferredTaskIds: Set<string>;

  refreshFromDb(): void;
  refreshWorkflowFromDb(workflowId: string): void;
  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  writeResetAndSync(
    before: TaskState,
    kind: TaskResetKind,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  updateSelectedAttempt(
    taskId: string,
    changes: Partial<
      Pick<
        Attempt,
        | 'status'
        | 'claimedAt'
        | 'startedAt'
        | 'completedAt'
        | 'exitCode'
        | 'error'
        | 'lastHeartbeatAt'
        | 'leaseExpiresAt'
        | 'branch'
        | 'commit'
        | 'summary'
        | 'workspacePath'
        | 'agentSessionId'
        | 'containerId'
        | 'mergeConflict'
      >
    >,
  ): void;
  replaceSelectedAttempt(
    task: TaskState,
    opts?: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>>,
    writeOpts?: { skipWorkflowStatusSync?: boolean },
  ): string;
  clearQueuedSchedulerEntries(taskId: string, attemptId?: string): void;
  invalidateLaunchArtifactsForTasks(taskIds: readonly string[], reason: string, now?: Date): void;
  checkWorkflowCompletion(): void;
  drainScheduler(): TaskState[];
}

// ── Extracted Functions ─────────────────────────────────────

/**
 * Cancel-first invariant defense-in-depth (Step 18 of
 * `docs/architecture/task-invalidation-roadmap.md`, Hard Invariant
 * from `docs/architecture/task-invalidation-chart.md`).
 *
 * Marks any actively-running task in the targeted scope as `failed`
 * with an explicit cancel marker BEFORE the caller resets state.
 * This guarantees the chart's "interrupt and cancel all in-flight
 * work in the affected scope" rule for direct callers of the
 * orchestrator primitives — notably the `commandService.retryTask`
 * / `recreateTask` / `retryWorkflow` / `recreateWorkflow` /
 * `recreateWorkflowFromFreshBase` lifecycle commands wired in
 * Step 17, which bypass the upstream `applyInvalidation` cancel.
 *
 * Calls via `applyInvalidation` already cancel via `cancelInFlight`
 * (executor kill + orchestrator-side `cancelTask`/`cancelWorkflow`),
 * so this helper is a defense-in-depth no-op there: by the time the
 * primitive runs the targeted scope has no active tasks and the
 * `isActive` filter below skips them all.
 *
 * Implementation notes:
 *   - Only `running` / `fixing_with_ai` tasks are touched. Pending /
 *     blocked / failed / completed / etc. tasks are left alone so
 *     the subsequent reset path (`resetSubgraphToPending` /
 *     `recreateWorkflow` / `replaceSelectedAttempt`) sees the
 *     expected lineage.
 *   - The selected attempt's status is intentionally NOT mutated
 *     here — the subsequent reset's `replaceSelectedAttempt` sees
 *     it as still `running` and marks it `superseded`, preserving
 *     the existing attempt-supersession contract that retry/recreate
 *     primitives (and their tests) rely on.
 *   - Deferred-set / queued scheduler entries are cleared per
 *     cancelled task so the slot frees up for the upcoming reset.
 */
export function cancelActiveBeforeInvalidationImpl(
  host: CancellationHost,
  scope: 'task' | 'workflow',
  id: string,
): string[] {
  let candidates: TaskState[];
  if (scope === 'task') {
    const root = host.stateGetTask(id);
    if (!root) return [];
    const allTasks = host.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const descendantIds = getTransitiveDependents(
      id,
      taskMap,
      (t) => t.status === 'completed' || t.status === 'stale',
    );
    candidates = [
      root,
      ...descendantIds
        .map((d) => taskMap.get(d))
        .filter((t): t is TaskState => !!t),
    ];
  } else {
    candidates = host.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === id);
  }

  return cancelActiveCandidatesImpl(host, candidates, scope);
}

/** Mark every actively-running task in `candidates` as `failed` with a cancel marker, freeing its scheduler slot. */
export function cancelActiveCandidatesImpl(
  host: CancellationHost,
  candidates: readonly TaskState[],
  scope: 'task' | 'workflow',
): string[] {
  const cancelled: string[] = [];
  for (const t of candidates) {
    if (!isActiveForInvalidation(t.status)) continue;
    const error = `Cancelled before ${scope}-scope invalidation`;
    const completedAt = new Date();
    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error, completedAt },
    };
    const updated = host.writeAndSync(t.id, changes);
    host.persistence.logEvent?.(t.id, 'task.cancelled', changes);
    host.messageBus.publish(TASK_DELTA_CHANNEL, host.buildUpdateDelta(t, updated, changes));
    host.deferredTaskIds.delete(t.id);
    host.clearQueuedSchedulerEntries(t.id, t.execution.selectedAttemptId);
    cancelled.push(t.id);
  }
  return cancelled;
}

/**
 * Cancel a task and cascade-cancel all downstream DAG dependents.
 * Returns cancelled task IDs and which were running (need process kill by caller).
 */
export function cancelTaskImpl(
  host: CancellationHost,
  taskId: string,
): { cancelled: string[]; runningCancelled: string[] } {
  host.refreshFromDb();

  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError('TASK_NOT_FOUND', `Task "${taskId}" not found`);

  const terminal: Partial<Record<TaskStatus, true>> = { completed: true, closed: true, stale: true };
  if (terminal[task.status]) {
    throw new OrchestratorError('TASK_ALREADY_TERMINAL', `Task "${taskId}" is already ${task.status}`);
  }

  // Find all transitive dependents, skipping completed/stale
  const rootId = task.id;
  const upstreamLabel =
    rootId.includes('/') && !rootId.startsWith('__merge__')
      ? rootId.slice(rootId.indexOf('/') + 1)
      : rootId;

  const allTasks = host.stateMachine.getAllTasks();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const descendantIds = getTransitiveDependents(
    rootId,
    taskMap,
    (t) => t.status === 'completed' || t.status === 'stale',
  );

  const toCancelIds = [rootId, ...descendantIds];
  const cancelled: string[] = [];
  const runningCancelled: string[] = [];
  host.invalidateLaunchArtifactsForTasks(toCancelIds, 'task cancellation');

  for (const id of toCancelIds) {
    const t = host.stateGetTask(id);
    if (!t || t.status === 'completed' || t.status === 'stale') continue;

    const wasRunning = t.status === 'running' || t.status === 'fixing_with_ai';

    // Free scheduler slot and deferred set
    host.deferredTaskIds.delete(id);
    if (wasRunning) {
      runningCancelled.push(id);
    }
    host.clearQueuedSchedulerEntries(id, t.execution.selectedAttemptId);

    // A downstream dependent that never started running was not itself
    // cancelled or failed — it was only ever waiting on the now-terminated
    // upstream. Mark it `blocked` (honest, retryable, and self-clearing:
    // when the upstream is retried to completion the scheduler unblocks it
    // via getReadyNodes/autoStartReadyTasks) instead of `failed`, so its
    // badge does not masquerade as a real run failure. The cancel root, and
    // any dependent that was actually executing when the cascade reached it,
    // stay `failed`.
    const neverStarted =
      id !== rootId &&
      !t.execution.startedAt &&
      (t.status === 'pending' || t.status === 'blocked');

    if (neverStarted) {
      const blockedChanges: TaskStateChanges = {
        status: 'blocked',
        execution: { blockedBy: `upstream task "${upstreamLabel}" was terminated` },
      };
      const blockedUpdated = host.writeAndSync(id, blockedChanges);
      const blockedDelta: TaskDelta = host.buildUpdateDelta(t, blockedUpdated, blockedChanges);
      host.persistence.logEvent?.(id, 'task.blocked', blockedChanges);
      host.messageBus.publish(TASK_DELTA_CHANNEL, blockedDelta);
      cancelled.push(id);
      continue;
    }

    // Mark as failed
    const errorMsg =
      id === rootId
        ? 'Terminated by user'
        : `Terminated: upstream task "${upstreamLabel}" was terminated`;
    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error: errorMsg, completedAt: new Date() },
    };
    const cancelUpdated = host.writeAndSync(id, changes);
    host.updateSelectedAttempt(id, {
      status: 'failed',
      error: errorMsg,
      completedAt: changes.execution?.completedAt,
    });
    const delta: TaskDelta = host.buildUpdateDelta(t, cancelUpdated, changes);
    host.persistence.logEvent?.(id, 'task.cancelled', changes);
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    cancelled.push(id);
  }

  host.checkWorkflowCompletion();
  return { cancelled, runningCancelled };
}

/**
 * Cancel all active tasks in a workflow.
 * Terminal tasks (completed/stale) are preserved as-is.
 */
export function cancelWorkflowImpl(
  host: CancellationHost,
  workflowId: string,
): { cancelled: string[]; runningCancelled: string[] } {
  host.refreshWorkflowFromDb(workflowId);

  const allTasks = host.stateMachine.getAllTasks().filter(
    (t) => t.config.workflowId === workflowId,
  );
  if (allTasks.length === 0) {
    throw new OrchestratorError('WORKFLOW_NOT_FOUND', `No tasks found for workflow ${workflowId}`);
  }

  const cancellable: Partial<Record<TaskStatus, true>> = {
    pending: true,
    running: true,
    fixing_with_ai: true,
    blocked: true,
    needs_input: true,
    review_ready: true,
    awaiting_approval: true,
  };

  const cancelled: string[] = [];
  const runningCancelled: string[] = [];
  host.invalidateLaunchArtifactsForTasks(
    allTasks.filter((task) => cancellable[task.status]).map((task) => task.id),
    'workflow cancellation',
  );

  for (const task of allTasks) {
    if (!cancellable[task.status]) continue;

    const id = task.id;
    const wasRunning = task.status === 'running' || task.status === 'fixing_with_ai';

    host.deferredTaskIds.delete(id);
    if (wasRunning) {
      runningCancelled.push(id);
    }
    host.clearQueuedSchedulerEntries(id, task.execution.selectedAttemptId);

    const changes: TaskStateChanges = {
      status: 'failed',
      execution: {
        error: 'Cancelled by user (workflow)',
        completedAt: new Date(),
      },
    };
    const wfCancelUpdated = host.writeAndSync(id, changes);
    host.updateSelectedAttempt(id, {
      status: 'failed',
      error: 'Cancelled by user (workflow)',
      completedAt: changes.execution?.completedAt,
    });
    host.persistence.logEvent?.(id, 'task.cancelled', changes);
    host.messageBus.publish(TASK_DELTA_CHANNEL, host.buildUpdateDelta(task, wfCancelUpdated, changes));
    cancelled.push(id);
  }

  host.checkWorkflowCompletion();
  return { cancelled, runningCancelled };
}

/**
 * Defer a running task back to pending when a resource limit is hit.
 * The task is re-enqueued when another task completes and frees a slot.
 */
export function deferTaskImpl(
  host: CancellationHost,
  taskId: string,
  reason?: {
    reason?: string;
    message?: string;
    attemptId?: string;
    phase?: string;
  },
): void {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) return;
  const id = task.id;
  host.invalidateLaunchArtifactsForTasks([id], 'task deferred');

  // Transition running → pending. A deferred launch must not retain the
  // launch-claimed phase; otherwise it can be mistaken for an actively
  // dispatchable launch with no executor owner.
  const changes: TaskStateChanges = buildTaskResetChanges('defer');
  const deferUpdated = host.writeResetAndSync(task, 'defer', changes);
  const delta: TaskDelta = host.buildUpdateDelta(task, deferUpdated, changes);
  host.persistence.logEvent?.(id, 'task.deferred', {
    ...changes,
    deferredAt: new Date(),
    reason: reason?.reason,
    message: reason?.message,
    attemptId: reason?.attemptId,
    phase: reason?.phase,
  });
  host.messageBus.publish(TASK_DELTA_CHANNEL, delta);

  // Remove any queued re-dispatch for this task; persisted attempt state now
  // owns active-slot truth.
  host.clearQueuedSchedulerEntries(id, task.execution.selectedAttemptId);

  host.replaceSelectedAttempt(task);

  // Park in deferred set — re-enqueued when a task completes
  host.deferredTaskIds.add(id);

  // Let other ready tasks fill the freed slot
  host.drainScheduler();
}
