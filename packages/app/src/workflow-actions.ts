/**
 * Shared workflow action functions used by all owner endpoints and clients.
 *
 * Each function performs an orchestrator mutation and returns TaskState[]
 * of affected tasks. The caller decides whether to executeTasks() and/or
 * waitForCompletion().
 */

import type { Logger } from '@invoker/contracts';
import type { Orchestrator, ExternalGatePolicyUpdate } from '@invoker/workflow-core';
import type {
  CancelInFlightFn,
  InvalidationDeps,
  InvalidationScope,
  TaskState,
} from '@invoker/workflow-core';
import {
  OrchestratorError,
  OrchestratorErrorCode,
  buildCancelInFlight as buildCoreCancelInFlight,
  parseMergeConflictError,
} from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner, ReviewGateCiFailureTrigger } from '@invoker/execution-engine';
import { normalizeMergeModeForPersistence } from './merge-mode.js';
import {
  isReviewGateCiContextStale,
  type ReviewGateCiContext,
} from './auto-fix-intents.js';
import { createDeleteAllSnapshot } from './delete-all-snapshot.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import { isDispatchableLaunch } from './global-topup.js';

type LoadedWorkflow = NonNullable<ReturnType<SQLiteAdapter['loadWorkflow']>>;

// ── Lineage guard ─────────────────────────────────────────────

/**
 * Thrown when a fix-with-agent or conflict-resolution mutation discovers
 * that the task lineage has changed since the mutation started (e.g. a
 * recreate-task moved the selectedAttemptId forward while the async fix
 * was in flight). Callers should treat this as a no-op: the task state
 * has already moved on and the late result must be discarded.
 */
export class StaleLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleLineageError';
  }
}

/** Snapshot of task identity captured at mutation entry. */
export interface TaskLineageSnapshot {
  taskId: string;
  selectedAttemptId: string | undefined;
  generation: number;
}

/**
 * Capture the current lineage for a task.
 */
export function captureTaskLineage(
  taskId: string,
  orchestrator: Pick<Orchestrator, 'getTask'>,
): TaskLineageSnapshot {
  const task = orchestrator.getTask(taskId);
  return {
    taskId,
    selectedAttemptId: task?.execution.selectedAttemptId,
    generation: task?.execution.generation ?? 0,
  };
}

/**
 * Assert that the task lineage has not changed since the snapshot and
 * that the abort signal (if any) has not fired.  Throws
 * `StaleLineageError` on mismatch.
 */
export function assertLineageCurrent(
  snapshot: TaskLineageSnapshot,
  orchestrator: Pick<Orchestrator, 'getTask'>,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw new StaleLineageError(
      `Fix mutation for ${snapshot.taskId} aborted: ${signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'unknown')}`,
    );
  }
  const current = captureTaskLineage(snapshot.taskId, orchestrator);
  if (
    current.selectedAttemptId !== snapshot.selectedAttemptId
    || current.generation !== snapshot.generation
  ) {
    throw new StaleLineageError(
      `Task ${snapshot.taskId} lineage changed during fix mutation `
      + `(attempt ${snapshot.selectedAttemptId} → ${current.selectedAttemptId}, `
      + `gen ${snapshot.generation} → ${current.generation})`,
    );
  }
}

// ── Deps interfaces ──────────────────────────────────────────

export interface ActionDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  /** @deprecated Pool cleanup uses the workflow mirror; repoRoot branch deletion is no longer used. */
  repoRoot?: string;
  /** When set, fresh-base actions refresh the pool mirror and remove managed branches before retry/recreate. */
  taskExecutor?: TaskRunner;
  mutationTiming?: WorkflowMutationTiming;
  /** When true, successful AI-applied fixes are approved immediately. */
  autoApproveAIFixes?: boolean;
}

export interface ApproveTaskResult {
  approvedTask?: TaskState;
  started: TaskState[];
  fixedTask: boolean;
}

// ── Actions ──────────────────────────────────────────────────

export function bumpGenerationAndRecreate(
  workflowId: string,
  deps: Pick<ActionDeps, 'logger' | 'persistence' | 'orchestrator'>,
): TaskState[] {
  const { persistence, orchestrator } = deps;
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `Workflow ${workflowId} not found`);
  const nextGen = (workflow.generation ?? 0) + 1;
  persistence.updateWorkflow(workflowId, { generation: nextGen });
  deps.logger?.info(`bumped generation to ${nextGen} for ${workflowId}`, { module: 'workflow' });
  deps.logger?.info(`bumpGenerationAndRecreate: calling recreateWorkflow(${workflowId})`, { module: 'agent-session-trace' });
  return orchestrator.recreateWorkflow(workflowId);
}

export async function approveTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'> & {
    taskExecutor?: TaskRunner;
    approve?: (taskId: string) => Promise<TaskState[]>;
    resumeAfterFixApproval?: (taskId: string) => Promise<TaskState[]>;
  },
): Promise<ApproveTaskResult> {
  const task = deps.orchestrator.getTask?.(taskId);
  const fixedTask = task?.execution.pendingFixError !== undefined;
  if (fixedTask && task && deps.taskExecutor) {
    await deps.taskExecutor.commitApprovedFix(task);
  }

  const shouldResume =
    fixedTask &&
    task !== undefined &&
    (task.config.isMergeNode || Boolean(parseMergeConflictError(task.execution.pendingFixError ?? '')));
  const started = await (
    shouldResume
      ? (deps.resumeAfterFixApproval ?? deps.orchestrator.resumeTaskAfterFixApproval.bind(deps.orchestrator))
      : (deps.approve ?? deps.orchestrator.approve.bind(deps.orchestrator))
  )(taskId);
  const postFixMerge = started.filter(
    (t) => t.status === 'running' && t.config.isMergeNode && t.id === taskId,
  );
  if (deps.taskExecutor) {
    for (const task of postFixMerge) {
      await deps.taskExecutor.publishAfterFix(task);
    }
  }
  return { approvedTask: task, started, fixedTask };
}

/**
 * Reject a task. Handles pendingFixError (from fix-with-claude) consistently
 * across all surfaces: if the task has a pending fix error, revert the
 * conflict resolution instead of rejecting outright.
 */
export function rejectTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  reason?: string,
): void {
  const task = deps.orchestrator.getTask(taskId);
  if (task?.execution.pendingFixError !== undefined) {
    deps.orchestrator.revertConflictResolution(taskId, task.execution.pendingFixError);
  } else {
    deps.orchestrator.reject(taskId, reason);
  }
}

export function provideInput(
  taskId: string,
  text: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): void {
  deps.orchestrator.provideInput(taskId, text);
}

export function retryTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.retryTask(taskId);
}

export function restartTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.recreateTask(taskId);
}

export function retryWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.retryWorkflow(workflowId);
}

export function recreateWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'logger' | 'persistence' | 'orchestrator'>,
): TaskState[] {
  return bumpGenerationAndRecreate(workflowId, deps);
}

function workflowIdFromMergeTaskId(target: string): string | undefined {
  if (!target.startsWith('__merge__')) return undefined;
  return target.slice('__merge__'.length) || undefined;
}

export function resolveWorkflowIdForRebaseTarget(
  target: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'>,
): string {
  const workflow = deps.persistence.loadWorkflow(target);
  if (workflow) return workflow.id;

  const mergeWorkflowId = workflowIdFromMergeTaskId(target);
  if (mergeWorkflowId && deps.persistence.loadWorkflow(mergeWorkflowId)) {
    return mergeWorkflowId;
  }

  const task = deps.orchestrator.getTask(target);
  if (task?.config.workflowId) return task.config.workflowId;

  for (const candidate of deps.persistence.listWorkflows()) {
    const storedTask = deps.persistence.loadTasks(candidate.id).find((item) => (
      item.id === target || item.id.endsWith(`/${target}`)
    ));
    if (storedTask) return candidate.id;
  }

  throw new OrchestratorError(
    OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
    `Could not resolve workflow for rebase target "${target}"`,
  );
}

export function recreateTask(
  taskId: string,
  deps: Pick<ActionDeps, 'persistence' | 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.recreateTask(taskId);
}

export function recreateDownstream(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.recreateDownstream(taskId);
}

export function cancelWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): { cancelled: string[]; runningCancelled: string[] } {
  return deps.orchestrator.cancelWorkflow(workflowId);
}

/**
 * Shared delete-all lifecycle bridge.
 *
 * Centralizes mutation ordering for the destructive delete-all
 * operation so both main (GUI IPC) and headless (CLI) entrypoints
 * share a single code path:
 *
 *   1. Create a DB snapshot (safety net — callers can abort on failure).
 *   2. Kill all running/fixing_with_ai executor processes so no
 *      orphaned child processes survive the purge.
 *   3. Delegate to `orchestrator.deleteAllWorkflows()` which handles
 *      DB purge → scheduler kill → memory clear → removal deltas.
 *
 * Returns the snapshot path (or null when the DB file does not yet
 * exist) so callers can log it through their own channel (stderr,
 * structured logger, etc.).
 */
export async function deleteAllWorkflows(
  deps: Pick<ActionDeps, 'logger' | 'orchestrator' | 'taskExecutor'>,
): Promise<{ snapshotPath: string | null }> {
  const snapshotPath = createDeleteAllSnapshot();
  deps.logger?.info(
    snapshotPath
      ? `delete-all-workflows snapshot: ${snapshotPath}`
      : 'delete-all-workflows snapshot skipped: DB file does not exist yet',
    { module: 'workflow' },
  );

  // Kill executor processes for all running/fixing_with_ai tasks before
  // the destructive purge.  Process management is outside orchestrator
  // scope (same convention as performDeleteWorkflow in main.ts), so we
  // handle it here in the shared bridge.
  const taskExecutor = deps.taskExecutor;
  if (taskExecutor) {
    const allTasks = deps.orchestrator.getAllTasks();
    const active = allTasks.filter(
      (t) => t.status === 'running' || t.status === 'fixing_with_ai',
    );
    for (const task of active) {
      deps.logger?.info(`delete-all: killing active task "${task.id}"`, { module: 'kill' });
      await taskExecutor.killActiveExecution(task.id);
    }
  }

  deps.orchestrator.deleteAllWorkflows();
  return { snapshotPath };
}

/**
 * Bulk delete-all variant that suppresses per-task removal deltas.
 *
 * Identical lifecycle to {@link deleteAllWorkflows} (snapshot → kill →
 * orchestrator purge) but passes `publishRemovalDeltas: false` so the
 * orchestrator skips individual `removed` TaskDelta messages.  The
 * caller is expected to notify the UI through a separate channel
 * (e.g. `invoker:workflows-changed`).
 */
export async function deleteAllWorkflowsBulk(
  deps: Pick<ActionDeps, 'logger' | 'orchestrator' | 'taskExecutor'>,
): Promise<{ snapshotPath: string | null }> {
  const snapshotPath = createDeleteAllSnapshot();
  deps.logger?.info(
    snapshotPath
      ? `delete-all-workflows-bulk snapshot: ${snapshotPath}`
      : 'delete-all-workflows-bulk snapshot skipped: DB file does not exist yet',
    { module: 'workflow' },
  );

  const taskExecutor = deps.taskExecutor;
  if (taskExecutor) {
    const allTasks = deps.orchestrator.getAllTasks();
    const active = allTasks.filter(
      (t) => t.status === 'running' || t.status === 'fixing_with_ai',
    );
    for (const task of active) {
      deps.logger?.info(`delete-all-bulk: killing active task "${task.id}"`, { module: 'kill' });
      await taskExecutor.killActiveExecution(task.id);
    }
  }

  deps.orchestrator.deleteAllWorkflows({ publishRemovalDeltas: false });
  return { snapshotPath };
}

/**
 * Recreate a workflow from a refreshed upstream base — the chart's
 * `recreateWorkflowFromFreshBase` action
 * (`docs/architecture/task-invalidation-chart.md` rows
 * "Rebase and retry" + "Repo/base invalidation inconsistency",
 * `docs/architecture/task-invalidation-roadmap.md` Step 12).
 *
 * This is strictly stronger than `recreateWorkflow`: in addition to
 * the full reset (workspace path, branch, commit, agent session,
 * container, merge gate workspace, etc.) it first refreshes the pool
 * mirror and origin base via `taskExecutor.preparePoolForRebaseRetry`
 * and removes managed experiment/invoker branches in that mirror.
 * Plain `recreateWorkflow` preserves the workflow's currently-known
 * upstream base; this one advances it.
 *
 * Wiring (composite, kept here per
 * `docs/architecture/task-invalidation-roadmap.md` "Out of scope":
 * the composite implementation is preserved semantically — replacing
 * it with a single primitive is a follow-up):
 *
 *   1. Bump the workflow's generation counter (matches
 *      `bumpGenerationAndRecreate` so any downstream observers that
 *      key off `workflow.generation` notice the new round).
 *   2. Delegate to `Orchestrator.recreateWorkflowFromFreshBase` with
 *      a `refreshBase` callback that runs
 *      `taskExecutor.preparePoolForRebaseRetry` when both
 *      `taskExecutor` and `workflow.repoUrl` are available. The
 *      orchestrator method is the seam that records the fresh-base
 *      effect (`knownFreshBaseCommits`) and then runs the same reset
 *      as `recreateWorkflow`. Cancel-first is supplied by
 *      `applyInvalidation`'s `cancelInFlight` dep
 *      (`buildCancelInFlight` → `Orchestrator.cancelWorkflow` +
 *      `taskExecutor.killActiveExecution`) when invoked through that
 *      route — this wrapper does not add a parallel cancel call.
 *
 * `preparePoolForRebaseRetry` resolves the fresh upstream HEAD once.
 * The explicit fresh-base lifecycle entrypoint can pass that commit
 * through to the orchestrator callback when available.
 */
async function prepareWorkflowFreshBase(
  workflowId: string,
  deps: ActionDeps,
): Promise<{ workflow: LoadedWorkflow; freshBase?: { branch: string; commit: string } }> {
  const workflow = deps.persistence.loadWorkflow(workflowId);
  if (!workflow) throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `Workflow ${workflowId} not found`);

  let freshBase: { branch: string; commit: string } | undefined;
  if (deps.taskExecutor && workflow.repoUrl) {
    const prepare = () => deps.mutationTiming
      ? deps.taskExecutor!.preparePoolForRebaseRetry(
        workflowId,
        workflow.repoUrl,
        workflow.baseBranch,
        deps.mutationTiming,
      )
      : deps.taskExecutor!.preparePoolForRebaseRetry(
        workflowId,
        workflow.repoUrl,
        workflow.baseBranch,
      );
    if (deps.mutationTiming) {
      freshBase = await deps.mutationTiming.span(
        'workflow-actions.prepareWorkflowFreshBase.preparePoolForRebaseRetry',
        { repoUrl: workflow.repoUrl, baseBranch: workflow.baseBranch },
        prepare,
      );
    } else {
      freshBase = await prepare();
    }
  }

  return { workflow, freshBase };
}

export async function recreateWorkflowFromFreshBase(
  workflowId: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const { workflow, freshBase } = await prepareWorkflowFreshBase(workflowId, deps);
  const nextGen = (workflow.generation ?? 0) + 1;
  deps.mutationTiming?.mark('workflow-actions.recreateWorkflowFromFreshBase.bumpGeneration', 'started', {
    nextGeneration: nextGen,
  });
  deps.persistence.updateWorkflow(workflowId, { generation: nextGen });
  deps.mutationTiming?.mark('workflow-actions.recreateWorkflowFromFreshBase.bumpGeneration', 'completed', {
    nextGeneration: nextGen,
  });
  deps.logger?.info(
    `recreateWorkflowFromFreshBase: workflowId=${workflowId} bumped generation to ${nextGen}`,
    { module: 'workflow' },
  );
  deps.logger?.info(
    `recreateWorkflowFromFreshBase: workflowId=${workflowId} → orchestrator.recreateWorkflowFromFreshBase`,
    { module: 'agent-session-trace' },
  );

  const recreate = () => deps.orchestrator.recreateWorkflowFromFreshBase(workflowId, {
    refreshBase: async () => {
      // Pool preparation already ran above. The callback is kept so the
      // orchestrator still sees the fresh-base lifecycle entrypoint.
      return freshBase;
    },
  });
  return deps.mutationTiming
    ? deps.mutationTiming.span('workflow-actions.recreateWorkflowFromFreshBase.orchestrator', undefined, recreate)
    : recreate();
}

export async function rebaseRetry(
  target: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const workflowId = resolveWorkflowIdForRebaseTarget(target, deps);
  deps.mutationTiming?.mark('workflow-actions.rebaseRetry', 'started', { target, workflowId });
  deps.logger?.info(
    `rebaseRetry: target=${target} workflowId=${workflowId} → prepare fresh base + retryWorkflow`,
    { module: 'agent-session-trace' },
  );
  await prepareWorkflowFreshBase(workflowId, deps);
  const retry = async (): Promise<TaskState[]> => Promise.resolve(deps.orchestrator.retryWorkflow(workflowId));
  const started = deps.mutationTiming
    ? await deps.mutationTiming.span('workflow-actions.rebaseRetry.orchestrator', undefined, retry)
    : await retry();
  deps.mutationTiming?.mark('workflow-actions.rebaseRetry', 'completed', {
    target,
    workflowId,
    startedCount: started.length,
  });
  return started;
}

export async function rebaseRecreate(
  target: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const workflowId = resolveWorkflowIdForRebaseTarget(target, deps);
  deps.mutationTiming?.mark('workflow-actions.rebaseRecreate', 'started', { target, workflowId });
  deps.logger?.info(
    `rebaseRecreate: target=${target} workflowId=${workflowId} → prepare fresh base + recreateWorkflow`,
    { module: 'agent-session-trace' },
  );
  await prepareWorkflowFreshBase(workflowId, deps);
  const recreate = async (): Promise<TaskState[]> => Promise.resolve(bumpGenerationAndRecreate(workflowId, deps));
  const started = deps.mutationTiming
    ? await deps.mutationTiming.span('workflow-actions.rebaseRecreate.orchestrator', undefined, recreate)
    : await recreate();
  deps.mutationTiming?.mark('workflow-actions.rebaseRecreate', 'completed', {
    target,
    workflowId,
    startedCount: started.length,
  });
  return started;
}

/**
 * Reference to a TaskRunner. Either a direct instance or a getter that
 * returns the current instance — the latter is required when the dep
 * builder runs before `taskExecutor` is constructed (the executor is
 * built lazily by `rebuildTaskRunner` after `commandService`).
 */
export type TaskExecutorRef = TaskRunner | (() => TaskRunner | null | undefined);

function resolveTaskExecutor(ref: TaskExecutorRef | undefined): TaskRunner | undefined {
  if (!ref) return undefined;
  if (typeof ref === 'function') return ref() ?? undefined;
  return ref;
}

export interface BuildCancelInFlightDeps {
  orchestrator: Orchestrator;
  taskExecutor?: TaskExecutorRef;
}

export function buildCancelInFlight(deps: BuildCancelInFlightDeps): CancelInFlightFn {
  return buildCoreCancelInFlight({
    orchestrator: deps.orchestrator,
    killActiveExecution: async (id) => {
      const taskExecutor = resolveTaskExecutor(deps.taskExecutor);
      if (!taskExecutor) return;
      await taskExecutor.killActiveExecution(id);
    },
  });
}

export type BuildInvalidationDepsArgs = Omit<
  Pick<ActionDeps, 'logger' | 'orchestrator' | 'persistence' | 'mutationTiming'>,
  'taskExecutor'
> & { taskExecutor?: TaskExecutorRef };

export function buildInvalidationDeps(deps: BuildInvalidationDepsArgs): InvalidationDeps {
  const cancelInFlight = buildCancelInFlight({
    orchestrator: deps.orchestrator,
    taskExecutor: deps.taskExecutor,
  });
  return {
    cancelInFlight,
    retryTask: (taskId: string) => deps.orchestrator.retryTask(taskId),
    recreateTask: (taskId: string) => deps.orchestrator.recreateTask(taskId),
    recreateDownstream: (taskId: string) => deps.orchestrator.recreateDownstream(taskId),
    retryWorkflow: (workflowId: string) => deps.orchestrator.retryWorkflow(workflowId),
    recreateWorkflow: (workflowId: string) =>
      bumpGenerationAndRecreate(workflowId, {
        logger: deps.logger,
        orchestrator: deps.orchestrator,
        persistence: deps.persistence,
      }),
    recreateWorkflowFromFreshBase: (workflowId: string) =>
      recreateWorkflowFromFreshBase(workflowId, {
        logger: deps.logger,
        orchestrator: deps.orchestrator,
        persistence: deps.persistence,
        taskExecutor: resolveTaskExecutor(deps.taskExecutor),
        mutationTiming: deps.mutationTiming,
      }),
    workflowFork: (workflowId: string) => {
      const result = deps.orchestrator.forkWorkflow(workflowId);
      deps.logger?.info(
        `workflowFork: source=${workflowId} fork=${result.forkedWorkflowId} started=${result.started.length}`,
        { module: 'workflow' },
      );
      return result.started;
    },
    // `scheduleOnly` is invoked by applyInvalidation WITHOUT a
    // preceding cancelInFlight; the underlying primitive is
    // workflow-agnostic and ignores the taskId argument.
    scheduleOnly: (_taskId: string) =>
      deps.orchestrator.autoStartExternallyUnblockedReadyTasks(),
    fixApprove: async (taskId: string) => {
      const result = await approveTask(taskId, {
        orchestrator: deps.orchestrator,
        taskExecutor: resolveTaskExecutor(deps.taskExecutor),
      });
      return result.started;
    },
    fixReject: (taskId: string) => {
      rejectTask(taskId, { orchestrator: deps.orchestrator });
      return [];
    },
    // For task scope, resolve the owning workflow first; if the task
    // is gone (detached), the cascade is a no-op.
    cascadeDownstream: (scope, id) => {
      const workflowId =
        scope === 'workflow'
          ? id
          : deps.orchestrator.getTask(id)?.config.workflowId;
      if (!workflowId) return [];
      return deps.orchestrator.cascadeInvalidationToDownstream(workflowId);
    },
  };
}

export function forkWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'logger'>,
): { forkedWorkflowId: string; sourceWorkflowId: string; started: TaskState[] } {
  const result = deps.orchestrator.forkWorkflow(workflowId);
  deps.logger?.info(
    `forkWorkflow: source=${workflowId} fork=${result.forkedWorkflowId} started=${result.started.length}`,
    { module: 'workflow' },
  );
  return result;
}

export function editTaskCommand(
  taskId: string,
  newCommand: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskCommand(taskId, newCommand);
}

export function editTaskPrompt(
  taskId: string,
  newPrompt: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskPrompt(taskId, newPrompt);
}

export function editTaskType(
  taskId: string,
  runnerKind: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  poolMemberId?: string,
): TaskState[] {
  return deps.orchestrator.editTaskType(taskId, runnerKind, poolMemberId);
}

export function editTaskAgent(
  taskId: string,
  agentName: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskAgent(taskId, agentName);
}

export function setTaskExternalGatePolicies(
  taskId: string,
  updates: ExternalGatePolicyUpdate[],
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.setTaskExternalGatePolicies(taskId, updates);
}

export function setWorkflowExternalGatePolicies(
  workflowId: string,
  updates: ExternalGatePolicyUpdate[],
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.setWorkflowExternalGatePolicies(workflowId, updates);
}

export function selectExperiment(
  taskId: string,
  experimentId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.selectExperiment(taskId, experimentId);
}

export async function selectExperiments(
  taskId: string,
  ids: string[],
  deps: Pick<ActionDeps, 'orchestrator'> & { taskExecutor: TaskRunner },
): Promise<TaskState[]> {
  if (ids.length === 1) {
    return deps.orchestrator.selectExperiment(taskId, ids[0]);
  }
  const { branch, commit } = await deps.taskExecutor.mergeExperimentBranches(taskId, ids);
  return deps.orchestrator.selectExperiments(taskId, ids, branch, commit);
}

/**
 * Merge-conflict resolution with Claude in the task worktree, then restart and execute.
 * Same sequence as GUI `invoker:resolve-conflict` and headless `resolve-conflict`.
 */
/**
 * Persist merge mode and re-run the merge node — **retry-class**
 * invalidation route per Step 9 of
 * `docs/architecture/task-invalidation-roadmap.md` and the Decision
 * Table row "Change merge mode" in
 * `docs/architecture/task-invalidation-chart.md`
 * (`MUTATION_POLICIES.mergeMode` → `retryTask` / task scope, scoped
 * to the merge node).
 *
 * Step 9 migrates this surface from an app-layer-only special case
 * to a proper orchestrator policy seam. Prior to Step 9 this wrapper
 * persisted the new mergeMode unconditionally and only restarted the
 * merge node when its status was `completed` / `awaiting_approval` /
 * `review_ready` — the chart's "Merge-mode inconsistency" section
 * explicitly flagged that as the bug ("only at the app layer, and
 * only when the merge node is already terminal or waiting … no
 * general active invalidation rule for an in-flight merge node").
 *
 * The substantive routing — same-mode no-op detection, cancel-first
 * interruption when the merge node is actively executing or waiting
 * on external review (`running` / `fixing_with_ai` /
 * `awaiting_approval` / `review_ready`), `mergeMode` persistence on
 * the workflow, and the retry-class reset via `restartTask` (today's
 * `retryTask` compatibility wire — see `MUTATION_POLICIES.mergeMode`
 * and `buildInvalidationDeps`) — now lives in
 * `Orchestrator.editTaskMergeMode`. That method is the synchronous
 * orchestrator-internal seam of `applyInvalidation`'s Hard Invariant
 * (cancel BEFORE authoritative reset) and reuses `restartTask`'s
 * reset shape so the merge node's `agentSessionId` / `containerId` /
 * `error` / `exitCode` / timing fields are cleared while
 * branch / workspacePath lineage survives — the chart's retry-class
 * semantics for merge-mode mutations.
 *
 * This wrapper deliberately stays a thin async delegate to keep the
 * public surface (`(workflowId, mergeMode, deps)` returning `void`)
 * backward compatible for IPC handlers (`invoker:set-merge-mode`),
 * the api-server (`POST /api/workflows/:id/merge-mode`), and Slack
 * surfaces. The merge-task-id translation (`workflowId → mergeNodeId`)
 * happens here because callers speak workflow ids; the orchestrator
 * speaks merge-node task ids. When the workflow has no merge node
 * (degenerate workflows that opted out of a merge gate) the wrapper
 * persists the new mode directly and returns — there is nothing to
 * retry. Input normalization (`'manual' | 'automatic' |
 * 'external_review'`) lives in the app layer because it concerns
 * UI/CLI input parsing, not the chart's invalidation routing.
 *
 * Cancel-first is enforced inside the orchestrator method — this
 * wrapper MUST NOT add a parallel cancel call.
 */
export async function setWorkflowMergeMode(
  workflowId: string,
  mergeMode: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskRunner },
): Promise<void> {
  const normalized = normalizeMergeModeForPersistence(mergeMode);
  const tasks = deps.persistence.loadTasks(workflowId);
  const mergeTask = tasks.find((t) => t.config.isMergeNode);
  if (!mergeTask) {
    deps.persistence.updateWorkflow(workflowId, { mergeMode: normalized });
    return;
  }
  const started = deps.orchestrator.editTaskMergeMode(mergeTask.id, normalized);
  const runnable = started.filter(isDispatchableLaunch);
  if (runnable.length > 0) {
    await deps.taskExecutor.executeTasks(runnable);
  }
}

/**
 * Persist new fix-session prompt / fix-session context and re-run
 * the failed task — **retry-class** invalidation route per Step 10
 * of `docs/architecture/task-invalidation-roadmap.md` and the
 * Decision Table row "Change fix prompt or fix context while
 * `fixing_with_ai`" in
 * `docs/architecture/task-invalidation-chart.md`
 * (`MUTATION_POLICIES.fixContext` → `retryTask` / task scope).
 *
 * Step 10 introduces this wrapper as a thin async delegate around
 * `Orchestrator.editTaskFixContext` (mirrors the Step 2–9 wrapper
 * pattern). Prior to Step 10 the fix-session mutation surface had
 * **no general policy** at all — the chart's "Fix-session
 * inconsistency" section flagged the bespoke
 * `beginConflictResolution` / `revertConflictResolution` rollback
 * as "one special active invalidation mechanism, not a general
 * one". The substantive routing — same-content no-op detection,
 * cancel-first interruption when the task is in an active fix
 * session (`fixing_with_ai`), `fixPrompt` / `fixContext`
 * persistence on the task config, and the retry-class reset via
 * `restartTask` (today's `retryTask` compatibility wire — see
 * `MUTATION_POLICIES.fixContext` and `buildInvalidationDeps`) —
 * lives in `Orchestrator.editTaskFixContext`. That method is the
 * synchronous orchestrator-internal seam of `applyInvalidation`'s
 * Hard Invariant (cancel BEFORE authoritative reset) and reuses
 * `restartTask`'s reset shape so the task's `agentSessionId` /
 * `containerId` / `error` / `exitCode` / timing fields are cleared
 * while branch / workspacePath lineage survives — the chart's
 * retry-class semantics for fix-context mutations.
 *
 * Cancel-first is enforced inside the orchestrator method — this
 * wrapper MUST NOT add a parallel cancel call.
 */
export async function setTaskFixContext(
  taskId: string,
  patch: { fixPrompt?: string; fixContext?: string },
  deps: Pick<ActionDeps, 'orchestrator'> & { taskExecutor: TaskRunner },
): Promise<TaskState[]> {
  const started = deps.orchestrator.editTaskFixContext(taskId, patch);
  const runnable = started.filter(isDispatchableLaunch);
  if (runnable.length > 0) {
    await deps.taskExecutor.executeTasks(runnable);
  }
  return started;
}

export async function resolveConflictAction(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence' | 'autoApproveAIFixes'> & { taskExecutor: TaskRunner },
  agentName?: string,
  signal?: AbortSignal,
): Promise<{ autoApproved: boolean; started: TaskState[] }> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const entryLineage = captureTaskLineage(taskId, orchestrator);
  assertLineageCurrent(entryLineage, orchestrator, signal);
  const { savedError } = orchestrator.beginConflictResolution(taskId);
  const lineage = captureTaskLineage(taskId, orchestrator);
  try {
    assertLineageCurrent(lineage, orchestrator, signal);
    await taskExecutor.resolveConflict(taskId, savedError, agentName);
    assertLineageCurrent(lineage, orchestrator, signal);
    return await finalizeAppliedFix(taskId, savedError, deps, signal, lineage);
  } catch (err) {
    if (err instanceof StaleLineageError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    assertLineageCurrent(lineage, orchestrator, signal);
    persistence.appendTaskOutput(taskId, `\n[Resolve Conflict] Failed: ${msg}`);
    assertLineageCurrent(lineage, orchestrator, signal);
    orchestrator.revertConflictResolution(taskId, savedError, msg);
    throw err;
  }
}

export type FixWithAgentActionResult =
  | { kind: 'fixWithAgent' | 'resolveConflict'; autoApproved: boolean; started: TaskState[] }
  | { kind: 'recreateWorkflowFromFreshBase'; workflowId: string; started: TaskState[] };

export async function fixWithAgentAction(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence' | 'autoApproveAIFixes'> & { taskExecutor: TaskRunner },
  options: {
    agentName?: string;
    recoveryRoute?: FailureRecoveryRoute;
    recreateOutputLabel?: string;
    failureOutputLabel?: string;
    reviewGateContext?: ReviewGateCiContext;
    signal?: AbortSignal;
  } = {},
): Promise<FixWithAgentActionResult> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const task = orchestrator.getTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);

  // Reject a stale review-gate CI auto-fix before mutating: if the task moved on
  // (re-selected attempt, new generation/review/branch) since the CI failure was
  // captured, the carried context is stale and the fix must not clobber newer work.
  if (options.reviewGateContext && isReviewGateCiContextStale(options.reviewGateContext, task.execution)) {
    throw new StaleLineageError(
      `Review-gate CI auto-fix for ${taskId} is stale (review=${options.reviewGateContext.reviewId})`,
    );
  }

  const savedError = task.execution.error ?? '';
  const recoveryRoute = options.recoveryRoute ?? selectFailureRecoveryRoute(task, savedError);
  if (recoveryRoute.kind === 'recreateWorkflowFromFreshBase') {
    if (options.recreateOutputLabel) {
      persistence.appendTaskOutput(
        taskId,
        `\n[${options.recreateOutputLabel}] Startup merge conflict detected; recreating workflow ${recoveryRoute.workflowId} from a fresh base.`,
      );
    }
    const started = await recreateWorkflowFromFreshBase(recoveryRoute.workflowId, deps);
    return {
      kind: recoveryRoute.kind,
      workflowId: recoveryRoute.workflowId,
      started,
    };
  }

  const entryLineage = captureTaskLineage(taskId, orchestrator);
  assertLineageCurrent(entryLineage, orchestrator, options.signal);
  const { savedError: persistedSavedError } = orchestrator.beginConflictResolution(taskId);
  const lineage = captureTaskLineage(taskId, orchestrator);
  try {
    assertLineageCurrent(lineage, orchestrator, options.signal);
    if (recoveryRoute.kind === 'resolveConflict') {
      await taskExecutor.resolveConflict(taskId, persistedSavedError, options.agentName);
    } else {
      const output = persistence.getTaskOutput(taskId);
      const fixContext = options.reviewGateContext?.fixContext;
      if (fixContext !== undefined) {
        await taskExecutor.fixWithAgent(taskId, output, options.agentName, persistedSavedError, fixContext);
      } else {
        await taskExecutor.fixWithAgent(taskId, output, options.agentName, persistedSavedError);
      }
    }
    assertLineageCurrent(lineage, orchestrator, options.signal);
    const result = await finalizeAppliedFix(taskId, persistedSavedError, deps, options.signal, lineage);
    return {
      kind: recoveryRoute.kind,
      autoApproved: result.autoApproved,
      started: result.started,
    };
  } catch (err) {
    if (err instanceof StaleLineageError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const errorLabel = options.failureOutputLabel
      ?? (recoveryRoute.kind === 'resolveConflict' ? 'Resolve Conflict' : `Fix with ${options.agentName ?? 'Claude'}`);
    assertLineageCurrent(lineage, orchestrator, options.signal);
    persistence.appendTaskOutput(taskId, `\n[${errorLabel}] Failed: ${msg}`);
    assertLineageCurrent(lineage, orchestrator, options.signal);
    orchestrator.revertConflictResolution(taskId, persistedSavedError, msg);
    throw err;
  }
}

export async function finalizeAppliedFix(
  taskId: string,
  savedError: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'autoApproveAIFixes'> & { taskExecutor: TaskRunner },
  signal?: AbortSignal,
  lineage?: TaskLineageSnapshot,
): Promise<{ autoApproved: boolean; started: TaskState[] }> {
  if (signal?.aborted) {
    throw new StaleLineageError(
      `Fix mutation for ${taskId} aborted before finalize: ${signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'unknown')}`,
    );
  }
  if (lineage) assertLineageCurrent(lineage, deps.orchestrator, signal);
  deps.orchestrator.setFixAwaitingApproval(taskId, savedError);
  if (!deps.autoApproveAIFixes) {
    return { autoApproved: false, started: [] };
  }

  if (lineage) assertLineageCurrent(lineage, deps.orchestrator, signal);
  const { started } = await approveTask(taskId, deps);
  return { autoApproved: true, started };
}

// ── Auto-fix helpers ─────────────────────────────────────────

export type FailureRecoveryRoute =
  | { kind: 'fixWithAgent' }
  | { kind: 'resolveConflict' }
  | { kind: 'recreateWorkflowFromFreshBase'; workflowId: string };

export function selectFailureRecoveryRoute(
  task: TaskState,
  savedError: string,
): FailureRecoveryRoute {
  if (!parseMergeConflictError(savedError)) {
    return { kind: 'fixWithAgent' };
  }

  const workspacePath = task.execution.workspacePath?.trim();
  if (workspacePath) {
    return { kind: 'resolveConflict' };
  }

  const workflowId = task.config.workflowId?.trim();
  if (!workflowId) {
    return { kind: 'resolveConflict' };
  }

  return { kind: 'recreateWorkflowFromFreshBase', workflowId };
}

type AutoFixAgentSelection = {
  selectedAgent: string;
  selectedAgentSource: 'config' | 'default';
  configuredAutoFixAgent?: string;
  fallbackChain: string;
};

function resolveAutoFixAgent(
  configuredAutoFixAgent: string | undefined,
): AutoFixAgentSelection {
  const configAgent = configuredAutoFixAgent?.trim() || undefined;
  if (configAgent) {
    return {
      selectedAgent: configAgent,
      selectedAgentSource: 'config',
      configuredAutoFixAgent: configAgent,
      fallbackChain: 'config->default',
    };
  }
  return {
    selectedAgent: 'claude',
    selectedAgentSource: 'default',
    configuredAutoFixAgent: undefined,
    fallbackChain: 'config(empty)->default',
  };
}

async function recordFixedIntegrationAnchor(
  taskId: string,
  task: TaskState,
  deps: {
    persistence: SQLiteAdapter;
    taskExecutor: TaskRunner;
    orchestrator?: Pick<Orchestrator, 'getTask'>;
    lineage?: TaskLineageSnapshot;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (deps.lineage && deps.orchestrator) {
    assertLineageCurrent(deps.lineage, deps.orchestrator, deps.signal);
  }
  const workspacePath = task.execution.workspacePath?.trim();
  if (!workspacePath) {
    deps.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-fixed-anchor-skip',
      reason: 'missing-workspace-path',
    });
    return;
  }
  try {
    const fixedIntegrationSha = (await deps.taskExecutor.execGitIn(['rev-parse', 'HEAD'], workspacePath)).trim();
    if (deps.lineage && deps.orchestrator) {
      assertLineageCurrent(deps.lineage, deps.orchestrator, deps.signal);
    }
    const fixedIntegrationRecordedAt = new Date();
    deps.persistence.updateTask(taskId, {
      execution: {
        fixedIntegrationSha,
        fixedIntegrationRecordedAt,
        fixedIntegrationSource: 'auto_fix',
      },
    });
    deps.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-fixed-anchor-recorded',
      fixedIntegrationSha,
      workspacePath,
    });
  } catch (err) {
    if (err instanceof StaleLineageError) throw err;
    deps.persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-fixed-anchor-failed',
      workspacePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function formatReviewGateCiSavedError(trigger: ReviewGateCiFailureTrigger): string {
  const lines = [
    `Review-gate CI failed for PR ${trigger.reviewId}.`,
    `PR: ${trigger.reviewUrl}`,
    trigger.headRef ? `Branch: ${trigger.headRef}` : undefined,
    trigger.headSha ? `Head SHA: ${trigger.headSha}` : undefined,
    `Status: ${trigger.statusText}`,
    '',
    'Failed checks:',
    ...trigger.failedChecks.map((check) => (
      `- ${check.name}${check.conclusion ? ` (${check.conclusion})` : ''}`
    )),
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

function formatReviewGateCiFixContext(trigger: ReviewGateCiFailureTrigger): string {
  const checkLines = trigger.failedChecks.map((check) => {
    const details = [
      check.conclusion ? `conclusion=${check.conclusion}` : undefined,
      check.detailsUrl ? `details=${check.detailsUrl}` : undefined,
      check.summary ? `summary=${check.summary}` : undefined,
    ].filter(Boolean).join(' ');
    return `- ${check.name}${details ? `: ${details}` : ''}`;
  });
  return [
    'This auto-fix was triggered by failed CI on an external review gate PR.',
    `PR: ${trigger.reviewUrl}`,
    `Review ID: ${trigger.reviewId}`,
    trigger.headRef ? `PR head ref: ${trigger.headRef}` : undefined,
    trigger.headSha ? `PR head SHA: ${trigger.headSha}` : undefined,
    trigger.branch ? `Invoker branch: ${trigger.branch}` : undefined,
    '',
    'Fix the code on this task branch so the failed PR checks pass.',
    'Preserve the original task intent and do not recreate the PR manually.',
    '',
    'Failed checks:',
    ...checkLines,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function assertReviewGateTriggerCurrent(
  trigger: ReviewGateCiFailureTrigger,
  orchestrator: Pick<Orchestrator, 'getTask'>,
): void {
  const task = orchestrator.getTask(trigger.taskId);
  if (!task) {
    throw new StaleLineageError(`Review-gate CI auto-fix task ${trigger.taskId} no longer exists`);
  }
  if (
    task.execution.selectedAttemptId !== trigger.selectedAttemptId ||
    (task.execution.generation ?? 0) !== trigger.generation ||
    task.execution.reviewId !== trigger.reviewId ||
    task.execution.branch !== trigger.branch
  ) {
    throw new StaleLineageError(`Review-gate CI auto-fix for ${trigger.taskId} is stale`);
  }
}

export async function autoFixOnReviewGateFailure(
  trigger: ReviewGateCiFailureTrigger,
  deps: {
    orchestrator: Orchestrator;
    persistence: SQLiteAdapter;
    taskExecutor: TaskRunner;
    getAutoFixAgent?: () => string | undefined;
    getAutoApproveAIFixes?: () => boolean | undefined;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const task = orchestrator.getTask(trigger.taskId);
  if (!task) return;
  if (task.status !== 'review_ready' && task.status !== 'awaiting_approval' && task.status !== 'failed') return;
  const max = orchestrator.getAutoFixRetryBudget(trigger.taskId);
  if (max <= 0) return;
  const attempts = (task.execution.autoFixAttempts ?? 0) + 1;
  if (attempts > max) return;

  assertReviewGateTriggerCurrent(trigger, orchestrator);
  if (deps.signal?.aborted) {
    throw new StaleLineageError(
      `Review-gate CI auto-fix for ${trigger.taskId} aborted: ${deps.signal.reason instanceof Error ? deps.signal.reason.message : String(deps.signal.reason ?? 'unknown')}`,
    );
  }
  persistence.updateTask(trigger.taskId, { execution: { autoFixAttempts: attempts } });
  const savedError = formatReviewGateCiSavedError(trigger);
  const fixContext = formatReviewGateCiFixContext(trigger);
  const agentSelection = resolveAutoFixAgent(deps.getAutoFixAgent?.());

  let persistedSavedError: string | undefined;
  let lineage: TaskLineageSnapshot | undefined;
  try {
    ({ savedError: persistedSavedError } = orchestrator.beginAutoFixSession(trigger.taskId, {
      savedError,
      expectedLineage: {
        taskId: trigger.taskId,
        selectedAttemptId: trigger.selectedAttemptId,
        generation: trigger.generation,
      },
    }));
    lineage = captureTaskLineage(trigger.taskId, orchestrator);
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    persistence.logEvent?.(trigger.taskId, 'debug.auto-fix', {
      phase: 'review-gate-ci-auto-fix-start',
      reviewId: trigger.reviewId,
      headSha: trigger.headSha ?? null,
      failedCheckCount: trigger.failedChecks.length,
      selectedAgent: agentSelection.selectedAgent,
    });
    const output = persistence.getTaskOutput(trigger.taskId);
    await taskExecutor.fixWithAgent(
      trigger.taskId,
      output,
      agentSelection.selectedAgent,
      persistedSavedError,
      fixContext,
    );
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    const latest = orchestrator.getTask(trigger.taskId);
    if (!latest) throw new StaleLineageError(`Review-gate CI auto-fix task ${trigger.taskId} disappeared`);
    await recordFixedIntegrationAnchor(trigger.taskId, latest, {
      persistence,
      taskExecutor,
      orchestrator,
      lineage,
      signal: deps.signal,
    });
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    const finalizeResult = await finalizeAppliedFix(trigger.taskId, persistedSavedError, {
      orchestrator,
      taskExecutor,
      autoApproveAIFixes: deps.getAutoApproveAIFixes?.() ?? true,
    }, deps.signal, lineage);
    persistence.logEvent?.(trigger.taskId, 'debug.auto-fix', {
      phase: 'review-gate-ci-auto-fix-finalize',
      autoApproved: finalizeResult.autoApproved,
      startedCount: finalizeResult.started.length,
    });
  } catch (err) {
    if (err instanceof StaleLineageError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (lineage) assertLineageCurrent(lineage, orchestrator, deps.signal);
    persistence.appendTaskOutput(
      trigger.taskId,
      `\n[Review Gate Auto-fix] Agent failed (attempt ${attempts}/${max}): ${msg}`,
    );
    if (persistedSavedError !== undefined) {
      if (lineage) assertLineageCurrent(lineage, orchestrator, deps.signal);
      orchestrator.revertConflictResolution(trigger.taskId, persistedSavedError, msg);
    }
  }
}
