/**
 * Extracted task-spec edit domain.
 *
 * These functions implement the `editTask*` spec-mutation surface
 * (command, prompt, executor type, executor pool, execution agent, merge
 * mode, fix context) as standalone functions operating on a `TaskEditHost`.
 * The Orchestrator delegates to them, keeping the methods on the class for
 * API compatibility (see `transitions.ts` for the same host-delegation
 * pattern).
 *
 * Behavior is intentionally identical to the previous in-class methods:
 * validation, cancel-first (Hard Invariant), write order, event names, delta
 * publication, and the post-edit invalidation dispatch (`recreateTask` /
 * `retryTask` selected by `MUTATION_POLICIES`) are preserved exactly. This
 * cluster writes no mutable Orchestrator field.
 */

import type { TaskState, TaskDelta, TaskStateChanges, TaskStatus } from '@invoker/workflow-graph';
import { normalizeRunnerKind } from '@invoker/workflow-graph';
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from '../orchestrator.js';
import type {
  OrchestratorPersistence,
  OrchestratorMessageBus,
} from '../orchestrator.js';
import { MUTATION_POLICIES } from '../invalidation-policy.js';
import type { InvalidationAction } from '../invalidation-policy.js';

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
 * Subset of Orchestrator that the task-edit functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface TaskEditHost {
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly availablePoolIds: ReadonlySet<string>;

  refreshFromDb(): void;
  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  cancelTask(taskId: string): { cancelled: string[]; runningCancelled: string[] };
  dispatchPostMutation(action: InvalidationAction, taskId: string): TaskState[];
}

// ── Extracted Functions ─────────────────────────────────────

export function editTaskCommandImpl(host: TaskEditHost, taskId: string, newCommand: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  const cmdChanges: TaskStateChanges = { config: { command: newCommand } };
  const cmdBefore = host.stateGetTask(taskId)!;
  const cmdUpdated = host.writeAndSync(taskId, cmdChanges);
  const cmdDelta: TaskDelta = host.buildUpdateDelta(cmdBefore, cmdUpdated, cmdChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', cmdChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, cmdDelta);

  return host.dispatchPostMutation(MUTATION_POLICIES.command.action, taskId);
}

export function editTaskPromptImpl(host: TaskEditHost, taskId: string, newPrompt: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  const promptChanges: TaskStateChanges = { config: { prompt: newPrompt } };
  const promptBefore = host.stateGetTask(taskId)!;
  const promptUpdated = host.writeAndSync(taskId, promptChanges);
  const promptDelta: TaskDelta = host.buildUpdateDelta(promptBefore, promptUpdated, promptChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', promptChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, promptDelta);

  return host.dispatchPostMutation(MUTATION_POLICIES.prompt.action, taskId);
}

export function editTaskTypeImpl(
  host: TaskEditHost,
  taskId: string,
  runnerKind: string,
  poolMemberId?: string,
): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);

  const effectiveType = normalizeRunnerKind(runnerKind) ?? runnerKind;

  // SSH requires repoUrl on the workflow to clone onto the remote host
  if (effectiveType === 'ssh' && task.config.workflowId && host.persistence.loadWorkflow) {
    const wf = host.persistence.loadWorkflow(task.config.workflowId);
    if (!wf?.repoUrl) {
      throw new Error(
        `Cannot switch task "${taskId}" to SSH: workflow has no repoUrl. ` +
        `Add repoUrl to the plan YAML.`,
      );
    }
  }

  const oldRunnerKind = task.config.runnerKind;
  const oldPoolMemberId =
    oldRunnerKind === 'ssh' ? (task.config as { poolMemberId?: string }).poolMemberId : undefined;
  const newPoolMemberId = effectiveType === 'ssh' ? poolMemberId : undefined;
  const hostKey = (et: string | undefined, rid: string | undefined): string =>
    et === 'ssh' ? `ssh:${rid ?? ''}` : 'local';
  const hostChanged =
    hostKey(oldRunnerKind, oldPoolMemberId) !==
    hostKey(effectiveType, newPoolMemberId);

  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  const configPatch: Record<string, unknown> = { runnerKind: effectiveType };
  if (effectiveType === 'ssh') {
    configPatch.poolMemberId = poolMemberId;
  } else {
    configPatch.poolMemberId = undefined;
  }
  const typeChanges: TaskStateChanges = { config: configPatch };
  const typeBefore = host.stateGetTask(taskId)!;
  const typeUpdated = host.writeAndSync(taskId, typeChanges);
  const typeDelta: TaskDelta = host.buildUpdateDelta(typeBefore, typeUpdated, typeChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', typeChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, typeDelta);

  const typeAction = hostChanged
    ? MUTATION_POLICIES.poolMemberId.action
    : MUTATION_POLICIES.runnerKind.action;
  return host.dispatchPostMutation(typeAction, taskId);
}

export function editTaskPoolImpl(host: TaskEditHost, taskId: string, poolId: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) throw new Error(`Cannot change executor pool of merge node ${taskId}`);
  if (!poolId || !host.availablePoolIds.has(poolId)) {
    throw new Error(
      `Cannot switch task "${taskId}" to poolId="${poolId}": pool is not defined in executionPools. ` +
      `Available: [${[...host.availablePoolIds].join(', ')}]`,
    );
  }

  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  const poolChanges: TaskStateChanges = {
    config: {
      poolId,
      runnerKind: undefined,
      poolMemberId: undefined,
    } as TaskStateChanges['config'],
  };
  const poolBefore = host.stateGetTask(taskId)!;
  const poolUpdated = host.writeAndSync(taskId, poolChanges);
  const poolDelta: TaskDelta = host.buildUpdateDelta(poolBefore, poolUpdated, poolChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', poolChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, poolDelta);

  return host.dispatchPostMutation(MUTATION_POLICIES.poolMemberId.action, taskId);
}

export function editTaskAgentImpl(host: TaskEditHost, taskId: string, agentName: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) throw new Error(`Cannot change execution agent of merge node ${taskId}`);

  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  const normalizedAgent = agentName.trim();
  const preservedExecutionModel = task.config.executionAgent?.trim() === normalizedAgent
    ? task.config.executionModel
    : undefined;
  const agentChanges: TaskStateChanges = {
    config: {
      executionAgent: agentName,
      executionModel: preservedExecutionModel,
    },
  };
  const agentBefore = host.stateGetTask(taskId)!;
  const agentUpdated = host.writeAndSync(taskId, agentChanges);
  const agentDelta: TaskDelta = host.buildUpdateDelta(agentBefore, agentUpdated, agentChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', agentChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, agentDelta);

  return host.dispatchPostMutation(MUTATION_POLICIES.executionAgent.action, taskId);
}

/**
 * Edit the merge mode of a workflow's merge node — **retry-class**
 * invalidation route per Step 9 of
 * `docs/architecture/task-invalidation-roadmap.md` and the Decision
 * Table row "Change merge mode" in
 * `docs/architecture/task-invalidation-chart.md`
 * (`MUTATION_POLICIES.mergeMode` → `retryTask` / task scope, scoped
 * to the merge node).
 *
 * Why retry-class (not recreate-class). The chart classifies a
 * merge-mode change as a merge-node-only execution-policy change:
 * the merge node's merge strategy (`manual` / `automatic` /
 * `external_review`) flips, but downstream branch/workspace lineage
 * and the upstream leaf results that feed the merge node are still
 * authoritative. The "Why" column reads "Merge execution policy
 * changed". `applyInvalidation('task','retryTask', mergeNodeId, deps)`
 * is wired to today's `Orchestrator.restartTask` via
 * `buildInvalidationDeps` (the compatibility seam Step 1 introduced;
 * Step 13 will rename `restartTask` → `retryTask` to close the matrix).
 *
 * Why this lives on the orchestrator (Step 9 migration). Prior to
 * Step 9 the merge-mode mutation surface was an app-layer-only
 * special case in `setWorkflowMergeMode` that restarted the merge
 * node *only* when it was already terminal or waiting
 * (`completed` / `awaiting_approval` / `review_ready`). Per the
 * chart's "Merge-mode inconsistency" section that left no general
 * active invalidation rule for an in-flight merge node — a `running`
 * merge node would silently keep using the old mode. Step 9 lifts
 * the routing into a proper orchestrator policy seam (this method)
 * so the Hard Invariant (cancel-first) and the retry-class reset
 * are enforced uniformly across all merge-node states; the app
 * wrapper becomes a thin delegate (mirrors Steps 2–6).
 *
 * Sequence (mirrors `applyInvalidation`'s contract for the
 * synchronous orchestrator-internal seam — see
 * `invalidation-policy.ts` and the Step 5/7/8 retry-class precedents):
 *   1. **Same-mode no-op.** If the workflow's persisted `mergeMode`
 *      already matches the requested value the method returns `[]`
 *      without canceling, persisting, or bumping the merge node's
 *      execution generation. This prevents a no-op rewrite from
 *      invalidating valid in-flight merge work.
 *   2. **Cancel-first (Hard Invariant).** If the merge node is
 *      actively executing or waiting on external review
 *      (`running` / `fixing_with_ai` / `awaiting_approval` /
 *      `review_ready`) we interrupt it via `cancelTask` BEFORE any
 *      authoritative state is reset. The chart's "Merge-mode
 *      inconsistency" section explicitly flags external-review
 *      waits and in-flight merge runs as scope that the new model
 *      must invalidate consistently. Inactive states
 *      (`pending` / `completed` / `failed` / `needs_input` /
 *      `blocked`) skip the cancel — there is no in-flight work to
 *      interrupt and `cancelTask` would otherwise mark a `pending`
 *      merge node as `failed`.
 *   3. **Persist new mode.** `persistence.updateWorkflow` writes the
 *      new `mergeMode` so the retried merge attempt picks up the
 *      new policy when it next runs.
 *   4. **Retry-class reset.** Delegate to `restartTask`, which is
 *      the current `retryTask` compatibility wire (Step 13 will
 *      rename it). `restartTask` resets the merge node to `pending`,
 *      clears volatile attempt state (`agentSessionId` /
 *      `containerId` / `error` / `exitCode` / `startedAt` /
 *      `completedAt`), and bumps execution generation exactly once
 *      via `withBumpedExecutionGeneration`. Crucially it does NOT
 *      clear `branch` / `workspacePath` — that lineage (the merge
 *      node's accumulated workspace) is the artifact the chart
 *      preserves for retry-class merge-mode mutations.
 *
 * Public surface: `(taskId, mergeMode)` returning `TaskState[]` of
 * newly-started tasks. `taskId` MUST be the merge node id
 * (`__merge__<workflowId>`); the workflow id is read from
 * `task.config.workflowId`. Throws if the task does not exist or is
 * not a merge node — keeping merge-mode mutation scoped to the
 * single execution policy slot the chart classifies. Backward-
 * compatible callers continue to use the workflow-scoped
 * `setWorkflowMergeMode` wrapper which translates `workflowId →
 * mergeNodeId` and delegates here.
 */
export function editTaskMergeModeImpl(
  host: TaskEditHost,
  taskId: string,
  mergeMode: 'manual' | 'automatic' | 'external_review',
): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (!task.config.isMergeNode) {
    throw new Error(`Task ${taskId} is not a merge node`);
  }
  const workflowId = task.config.workflowId;
  if (!workflowId) {
    throw new Error(`Merge node ${taskId} has no workflowId`);
  }

  // Step 9 same-mode no-op: skip cancel + persist + retry when the
  // requested mode already matches what's persisted on the workflow.
  // Without this guard a UI/CLI re-affirm would needlessly cancel
  // active merge work and bump the merge node's execution generation.
  const wf = host.persistence.loadWorkflow?.(workflowId);
  if (wf && wf.mergeMode === mergeMode) {
    return [];
  }

  // Step 9 cancel-first (chart Hard Invariant): when the merge node
  // is actively executing or waiting on external review, interrupt
  // it BEFORE we mutate the workflow's mergeMode and reset merge
  // state. Stale merge work (an in-flight merge run, a merge fix
  // session, or an external review wait) cannot survive a policy
  // change because the merge attempt's execution input — the merge
  // mode — just changed. Inactive statuses
  // (`pending`/`completed`/`failed`/`needs_input`/`blocked`) skip
  // cancel: there is no in-flight work to interrupt and
  // `cancelTask` would otherwise mark a `pending` merge node as
  // `failed`.
  if (isActiveForInvalidation(task.status)) {
    host.cancelTask(taskId);
  }

  // Persist new mode on the workflow record so the retried merge
  // attempt picks up the new policy when restartTask reschedules it.
  host.persistence.updateWorkflow?.(workflowId, { mergeMode });

  // Retry-class reset via the policy table — `restartTask` is the
  // current `retryTask` compatibility wire. Routing through
  // `MUTATION_POLICIES.mergeMode` keeps merge-mode dispatch
  // table-driven so a chart change propagates without touching this
  // method body.
  return host.dispatchPostMutation(MUTATION_POLICIES.mergeMode.action, taskId);
}

/**
 * Edit a task's fix-session prompt and/or context — **retry-class**
 * invalidation route per Step 10 of
 * `docs/architecture/task-invalidation-roadmap.md` and the Decision
 * Table row "Change fix prompt or fix context while `fixing_with_ai`"
 * in `docs/architecture/task-invalidation-chart.md`
 * (`MUTATION_POLICIES.fixContext` → `retryTask` / task scope).
 *
 * Why this is a migration, not a new policy. Prior to Step 10 the
 * fix-session mutation surface had **no general policy** at all —
 * the chart's "Behavior Today" column flags this row as
 * "only command edit has explicit handling today; no general
 * fix-context mutation policy" and the chart's "Fix-session
 * inconsistency" subsection calls out the bespoke
 * `beginFixSession` / `revertFixSession` rollback
 * as "one special active invalidation mechanism, not a general
 * one". Step 10 lifts that bespoke fix-session handling into a
 * proper orchestrator policy seam (`Orchestrator.editTaskFixContext`)
 * so cancel-first + retry-class reset are enforced uniformly across
 * `failed` and `fixing_with_ai` task states; the app wrapper
 * (`setTaskFixContext`) becomes a thin async delegate (mirrors
 * Steps 2–9).
 *
 * "Retry from reverted failed state" semantics. The chart's
 * `Target Action` column for this row reads
 * `retryTask` from reverted failed state — i.e. when the user
 * changes `fixPrompt`/`fixContext` mid-fix-session the in-flight
 * AI fix attempt is dropped, the task lineage falls back to its
 * `failed` baseline (volatile fix-attempt state — `agentSessionId`,
 * `containerId`, transient `error`/`exitCode`/timing fields —
 * cleared by `restartTask`), and a fresh fix attempt is scheduled
 * with the new prompt/context. Branch / workspacePath lineage
 * survives because this is the same failed task being retried
 * through the fix loop, not a new task topology.
 *
 * Sequence (mirrors `applyInvalidation`'s contract for the
 * synchronous orchestrator-internal seam — see
 * `invalidation-policy.ts` and the Step 9 `editTaskMergeMode`
 * precedent):
 *   1. **Same-content no-op.** If neither `fixPrompt` nor
 *      `fixContext` is changing (omitted keys count as "no
 *      change"), return `[]` without canceling, persisting, or
 *      bumping execution generation. Without this guard a UI/CLI
 *      re-affirm of identical fix context would needlessly cancel
 *      an active fix session and bump the task's execution
 *      generation.
 *   2. **Cancel-first (Hard Invariant).** When the task is
 *      actively running an AI fix (`fixing_with_ai`) interrupt it
 *      via `cancelTask` BEFORE the new fix prompt/context is
 *      persisted or `restartTask` resets the task. A failed task
 *      (the inactive fix-loop state) skips cancel — there is no
 *      in-flight fix attempt to interrupt and `cancelTask` would
 *      otherwise treat the failed task as already settled.
 *   3. **Persist new fix prompt/context.** `writeAndSync` updates
 *      `config.fixPrompt` / `config.fixContext` (only the keys
 *      present in the patch) and emits a `task.updated` delta so
 *      the retried fix attempt picks up the new prompt/context.
 *   4. **Retry-class reset.** Delegate to `restartTask` (today's
 *      `retryTask` compatibility wire — see
 *      `MUTATION_POLICIES.fixContext` and `buildInvalidationDeps`).
 *      It resets the task to `pending`, clears volatile attempt
 *      state (`agentSessionId`, `containerId`, transient
 *      `error`/`exitCode`/timing fields), and bumps execution
 *      generation exactly once via
 *      `withBumpedExecutionGeneration`, preserving branch /
 *      workspacePath lineage. This is the chart's "retry from
 *      reverted failed state" baseline.
 *
 * Patch shape: `{ fixPrompt?, fixContext? }`. Either or both keys
 * may be present. Omitted keys leave the existing config field
 * untouched — same-content detection treats missing keys as "no
 * change" so a `fix-prompt`-only edit does not clobber an
 * existing `fixContext`.
 *
 * Active states accepted: `failed`, `fixing_with_ai`. Other states
 * throw — the chart scopes this mutation to the fix loop.
 *
 * NOTE: `restartTask` is intentionally used here (not
 * `recreateTask`) because Step 10 is retry-class — fix
 * prompt/context changes do NOT change the task's execution-defining
 * spec (`command` / `prompt` / `executionAgent` / `runnerKind` /
 * `poolMemberId`); they only redirect the AI fix attempt that
 * runs against an already-failed task lineage.
 */
export function editTaskFixContextImpl(
  host: TaskEditHost,
  taskId: string,
  patch: { fixPrompt?: string; fixContext?: string },
): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (task.config.isMergeNode) {
    throw new Error(`Cannot edit fix context of merge node ${taskId}`);
  }
  if (task.status !== 'failed' && task.status !== 'fixing_with_ai') {
    throw new Error(
      `Cannot edit fix context for task "${taskId}" in status "${task.status}" ` +
        `(expected: failed | fixing_with_ai)`,
    );
  }

  // Step 10 same-content no-op: skip cancel + persist + retry when
  // neither key in the patch differs from the persisted config.
  // Omitted keys count as "no change" so a prompt-only edit does
  // not require the caller to also re-supply the existing context.
  const hasPromptKey = Object.prototype.hasOwnProperty.call(patch, 'fixPrompt');
  const hasContextKey = Object.prototype.hasOwnProperty.call(patch, 'fixContext');
  const promptMatches = !hasPromptKey || patch.fixPrompt === task.config.fixPrompt;
  const contextMatches = !hasContextKey || patch.fixContext === task.config.fixContext;
  if (promptMatches && contextMatches) {
    return [];
  }

  // Step 10 cancel-first (chart Hard Invariant): when the task is
  // actively running an AI fix attempt (`fixing_with_ai`) interrupt
  // it BEFORE we persist the new fix prompt/context and reset the
  // task via `restartTask`. The in-flight fix attempt's execution
  // input — the prompt/context — just changed, so it cannot
  // survive. A failed task (the inactive fix-loop state) skips
  // cancel: there is no in-flight fix attempt to interrupt.
  if (task.status === 'fixing_with_ai') {
    host.cancelTask(taskId);
  }

  const configPatch: Record<string, unknown> = {};
  if (hasPromptKey) configPatch.fixPrompt = patch.fixPrompt;
  if (hasContextKey) configPatch.fixContext = patch.fixContext;
  const fixContextChanges: TaskStateChanges = { config: configPatch };
  const fixBefore = host.stateGetTask(taskId)!;
  const fixUpdated = host.writeAndSync(taskId, fixContextChanges);
  const fixContextDelta: TaskDelta = host.buildUpdateDelta(fixBefore, fixUpdated, fixContextChanges);
  host.persistence.logEvent?.(taskId, 'task.updated', fixContextChanges);
  host.messageBus.publish(TASK_DELTA_CHANNEL, fixContextDelta);

  // Retry-class reset via the policy table — `restartTask` is the
  // current `retryTask` compatibility wire. Routing through
  // `MUTATION_POLICIES.fixContext` keeps fix-context dispatch
  // table-driven so a chart change propagates without touching this
  // method body.
  return host.dispatchPostMutation(MUTATION_POLICIES.fixContext.action, taskId);
}
