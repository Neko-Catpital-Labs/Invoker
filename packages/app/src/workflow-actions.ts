/**
 * Shared workflow action functions used by all owner endpoints and clients.
 *
 * Each function performs an orchestrator mutation and returns TaskState[]
 * of affected tasks. The caller decides whether to executeTasks() and/or
 * waitForCompletion().
 */

import type { Logger } from '@invoker/contracts';
import type {
  CommandService,
  Orchestrator,
  ExternalGatePolicyUpdate,
  InvalidationAction,
  TaskState,
} from '@invoker/workflow-core';
import {
  OrchestratorError,
  OrchestratorErrorCode,
  applyInvalidation,
  buildWorkflowInvalidationDeps,
  parseMergeConflictError,
} from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner, ReviewGateCiFailureTrigger } from '@invoker/execution-engine';
import { normalizeMergeModeForPersistence } from './merge-mode.js';
import {
  isReviewGateCiContextStale,
  type ReviewGateCiContext,
  type ReviewGateLineageFields,
} from './auto-fix-intents.js';
import { createDeleteAllSnapshot } from './delete-all-snapshot.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import { isDispatchableLaunch } from './global-topup.js';

type LoadedWorkflow = NonNullable<ReturnType<SQLiteAdapter['loadWorkflow']>>;
type FreshBaseState = { branch: string; commit: string };

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

function assertReviewGateCiContextCurrent(
  taskId: string,
  context: ReviewGateCiContext,
  current: ReviewGateLineageFields,
): void {
  if (!isReviewGateCiContextStale(context, current)) return;
  throw new StaleLineageError(
    `Review-gate CI auto-fix for ${taskId} is stale (review=${context.reviewId})`,
  );
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

export interface CommandActionDeps extends ActionDeps {
  commandService: CommandService;
}

export interface ApproveTaskResult {
  approvedTask?: TaskState;
  started: TaskState[];
  fixedTask: boolean;
}

// ── Actions ──────────────────────────────────────────────────

function requireWorkflowRecord(
  workflowId: string,
  persistence: Pick<ActionDeps, 'persistence'>['persistence'],
): LoadedWorkflow {
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) {
    throw new OrchestratorError(
      OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
      `Workflow ${workflowId} not found`,
    );
  }
  return workflow;
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

function commandResultError(error: { code: string; message: string }): Error {
  const known = (Object.values(OrchestratorErrorCode) as string[]).includes(error.code);
  return known
    ? new OrchestratorError(error.code as OrchestratorErrorCode, error.message)
    : new Error(error.message);
}

async function runWorkflowInvalidationThroughCommandService(
  workflowId: string,
  action: Extract<InvalidationAction, 'retryWorkflow' | 'recreateWorkflow' | 'recreateWorkflowFromFreshBase'>,
  deps: CommandActionDeps,
  options: {
    timingLabel: string;
    beforeApply?: () => Promise<void>;
  },
): Promise<TaskState[]> {
  const result = await deps.commandService.runSerializedForWorkflow(
    workflowId,
    async () => {
      if (options.beforeApply) await options.beforeApply();
      const run = () => applyInvalidation(
        'workflow',
        action,
        workflowId,
        createInvalidationDeps({
          logger: deps.logger,
          orchestrator: deps.orchestrator,
          persistence: deps.persistence,
          taskExecutor: deps.taskExecutor,
          mutationTiming: deps.mutationTiming,
        }),
      );
      return deps.mutationTiming
        ? deps.mutationTiming.span(options.timingLabel, undefined, run)
        : run();
    },
  );
  if (!result.ok) throw commandResultError(result.error);
  return result.data;
}

async function runTaskInvalidationThroughCommandService(
  taskId: string,
  action: Extract<InvalidationAction, 'retryTask' | 'recreateTask'>,
  deps: CommandActionDeps,
  timingLabel: string,
): Promise<TaskState[]> {
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  const result = await deps.commandService.runSerializedForWorkflow(
    workflowId,
    async () => {
      const run = () => applyInvalidation(
        'task',
        action,
        taskId,
        createInvalidationDeps({
          logger: deps.logger,
          orchestrator: deps.orchestrator,
          persistence: deps.persistence,
          taskExecutor: deps.taskExecutor,
          mutationTiming: deps.mutationTiming,
        }),
      );
      return deps.mutationTiming
        ? deps.mutationTiming.span(timingLabel, undefined, run)
        : run();
    },
  );
  if (!result.ok) throw commandResultError(result.error);
  return result.data;
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
 *   1. Bump the workflow's generation counter so downstream observers
 *      that key off `workflow.generation` notice the new round.
 *   2. Delegate to `Orchestrator.recreateWorkflowFromFreshBase` with
 *      a `refreshBase` callback that runs
 *      `preparePoolForRebaseRetry(workflowId, repoUrl, baseBranch, …)`
 *      first when both `taskExecutor` and `workflow.repoUrl` are
 *      available.
 *   3. Rely on `applyInvalidation`'s `cancelInFlight` dep for the
 *      cancel-first invariant. This wrapper does not add a parallel
 *      cancel call.
 *
 * `preparePoolForRebaseRetry` resolves the fresh upstream HEAD once.
 * The explicit fresh-base lifecycle entrypoint can pass that commit
 * through to the orchestrator callback when available.
 */
async function prepareFreshBaseWithWorkflow(
  workflowId: string,
  workflow: LoadedWorkflow,
  deps: ActionDeps,
): Promise<FreshBaseState | undefined> {
  if (!deps.taskExecutor || !workflow.repoUrl) return undefined;
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
    return deps.mutationTiming.span(
      'workflow-actions.prepareWorkflowFreshBase.preparePoolForRebaseRetry',
      { repoUrl: workflow.repoUrl, baseBranch: workflow.baseBranch },
      prepare,
    );
  }
  return prepare();
}

async function prepareWorkflowFreshBase(
  workflowId: string,
  deps: ActionDeps,
): Promise<{ workflow: LoadedWorkflow; freshBase?: FreshBaseState }> {
  const workflow = requireWorkflowRecord(workflowId, deps.persistence);
  const freshBase = await prepareFreshBaseWithWorkflow(workflowId, workflow, deps);
  return { workflow, freshBase };
}

function createInvalidationDeps(
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence' | 'mutationTiming'> & {
    logger?: Logger;
    taskExecutor?: TaskExecutorRef;
  },
) {
  return buildWorkflowInvalidationDeps({
    orchestrator: deps.orchestrator,
    requireWorkflow: (workflowId) => requireWorkflowRecord(workflowId, deps.persistence),
    setWorkflowGeneration: (workflowId, generation) => {
      deps.persistence.updateWorkflow(workflowId, { generation });
    },
    killActiveExecution: async (taskId) => {
      const taskExecutor = resolveTaskExecutor(deps.taskExecutor);
      if (!taskExecutor) return;
      await taskExecutor.killActiveExecution(taskId);
    },
    prepareFreshBase: (workflowId, workflow) =>
      prepareFreshBaseWithWorkflow(workflowId, workflow as LoadedWorkflow, {
        logger: deps.logger,
        orchestrator: deps.orchestrator,
        persistence: deps.persistence,
        taskExecutor: resolveTaskExecutor(deps.taskExecutor),
        mutationTiming: deps.mutationTiming,
      }),
    fixApprove: async (taskId) => {
      const result = await approveTask(taskId, {
        orchestrator: deps.orchestrator,
        taskExecutor: resolveTaskExecutor(deps.taskExecutor),
      });
      return result.started;
    },
    fixReject: (taskId) => {
      rejectTask(taskId, { orchestrator: deps.orchestrator });
      return [];
    },
  });
}

export async function recreateWorkflowFromFreshBase(
  workflowId: string,
  deps: CommandActionDeps,
): Promise<TaskState[]> {
  return runWorkflowInvalidationThroughCommandService(
    workflowId,
    'recreateWorkflowFromFreshBase',
    deps,
    { timingLabel: 'workflow-actions.recreateWorkflowFromFreshBase.applyInvalidation' },
  );
}

export async function rebaseRetry(
  target: string,
  deps: CommandActionDeps,
): Promise<TaskState[]> {
  const workflowId = resolveWorkflowIdForRebaseTarget(target, deps);
  deps.mutationTiming?.mark('workflow-actions.rebaseRetry', 'started', { target, workflowId });
  deps.logger?.info(
    `rebaseRetry: target=${target} workflowId=${workflowId} → CommandService/applyInvalidation retryWorkflow`,
    { module: 'agent-session-trace' },
  );
  const started = await runWorkflowInvalidationThroughCommandService(
    workflowId,
    'retryWorkflow',
    deps,
    {
      timingLabel: 'workflow-actions.rebaseRetry.applyInvalidation',
      beforeApply: () => prepareWorkflowFreshBase(workflowId, deps).then(() => undefined),
    },
  );
  deps.mutationTiming?.mark('workflow-actions.rebaseRetry', 'completed', {
    target,
    workflowId,
    startedCount: started.length,
  });
  return started;
}

export async function rebaseRecreate(
  target: string,
  deps: CommandActionDeps,
): Promise<TaskState[]> {
  const workflowId = resolveWorkflowIdForRebaseTarget(target, deps);
  deps.mutationTiming?.mark('workflow-actions.rebaseRecreate', 'started', { target, workflowId });
  deps.logger?.info(
    `rebaseRecreate: target=${target} workflowId=${workflowId} → CommandService/applyInvalidation recreateWorkflowFromFreshBase`,
    { module: 'agent-session-trace' },
  );
  const started = await runWorkflowInvalidationThroughCommandService(
    workflowId,
    'recreateWorkflowFromFreshBase',
    deps,
    { timingLabel: 'workflow-actions.rebaseRecreate.applyInvalidation' },
  );
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
 * Step 9 moved this surface out of the old app-layer special case and
 * into the shared invalidation pipeline. The merge node now restarts
 * through the same cancel-first rule as the rest of the lifecycle
 * matrix, including when it was already terminal or waiting.
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
 * Step 10 routes this through the shared invalidation pipeline instead
 * of a one-off app-layer path. `Orchestrator.editTaskFixContext`
 * remains the synchronous orchestrator seam reused by that pipeline.
 * That seam owns same-content no-op detection, cancel-first behavior
 * while the task is `fixing_with_ai`, config persistence, and the
 * retry-class reset. It reuses `restartTask`'s reset shape so
 * `agentSessionId`, `containerId`, `error`, `exitCode`, and timing
 * fields are cleared while branch / workspacePath lineage survives.
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
  deps: Pick<CommandActionDeps, 'logger' | 'orchestrator' | 'persistence' | 'autoApproveAIFixes' | 'commandService' | 'mutationTiming'> & { taskExecutor: TaskRunner },
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

  if (options.reviewGateContext) {
    assertReviewGateCiContextCurrent(taskId, options.reviewGateContext, task.execution);
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

function tailText(value: unknown, maxChars: number = 2000): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= maxChars) return value;
  return value.slice(-maxChars);
}

function formatAutoFixDiagnostics(err: unknown): string | undefined {
  const e = err as {
    exitCode?: unknown;
    cmd?: unknown;
    args?: unknown;
    cwd?: unknown;
    sessionId?: unknown;
    stdoutTail?: unknown;
    stderrTail?: unknown;
  };
  const parts: string[] = [];
  if (typeof e.exitCode === 'number') parts.push(`exitCode: ${e.exitCode}`);
  if (typeof e.cmd === 'string') parts.push(`cmd: ${e.cmd}`);
  if (Array.isArray(e.args)) parts.push(`args: ${JSON.stringify(e.args)}`);
  if (typeof e.cwd === 'string') parts.push(`cwd: ${e.cwd}`);
  if (typeof e.sessionId === 'string') parts.push(`sessionId: ${e.sessionId}`);
  const stderrTail = tailText(e.stderrTail);
  if (stderrTail) parts.push(`stderrTail:\n${stderrTail}`);
  const stdoutTail = tailText(e.stdoutTail);
  if (stdoutTail) parts.push(`stdoutTail:\n${stdoutTail}`);
  if (parts.length === 0) return undefined;
  return parts.join('\n');
}

type AutoFixAgentSelection = {
  selectedAgent: string;
  selectedAgentSource: 'config' | 'default';
  configuredAutoFixAgent?: string;
  fallbackChain: string;
};

type AutoFixPostRouteStrategy = 'rerun_task' | 'resume_from_fixed_tip';

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

function selectAutoFixPostRouteStrategy(task: TaskState): AutoFixPostRouteStrategy {
  return task.config.isMergeNode ? 'resume_from_fixed_tip' : 'rerun_task';
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

/**
 * Automatically fix a failed task with an AI agent and restart it.
 * Increments autoFixAttempts; respects the max budget from shouldAutoFix().
 */
export async function autoFixOnFailure(
  taskId: string,
  deps: {
    logger?: Logger;
    orchestrator: Orchestrator;
    persistence: SQLiteAdapter;
    commandService: CommandService;
    taskExecutor: TaskRunner;
    mutationTiming?: WorkflowMutationTiming;
    getAutoFixAgent?: () => string | undefined;
    getAutoApproveAIFixes?: () => boolean | undefined;
    signal?: AbortSignal;
  },
  inlineRetryDepth = 0,
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  if (!orchestrator.shouldAutoFix(taskId)) return;

  const task = orchestrator.getTask(taskId);
  if (!task || task.status !== 'failed') return;

  const entryLineage = captureTaskLineage(taskId, orchestrator);
  assertLineageCurrent(entryLineage, orchestrator, deps.signal);
  const attempts = (task.execution.autoFixAttempts ?? 0) + 1;
  const max = orchestrator.getAutoFixRetryBudget(taskId);
  const savedError = task.execution.error ?? '';
  const recoveryRoute = selectFailureRecoveryRoute(task, savedError);
  console.log(`[auto-fix] "${taskId}" attempt ${attempts}/${max}`);
  persistence.logEvent?.(taskId, 'debug.auto-fix', {
    phase: 'auto-fix-start',
    status: task.status,
    attemptsBefore: task.execution.autoFixAttempts ?? 0,
    attemptsAfter: attempts,
    maxRetries: max,
    hasExecutionError: Boolean(task.execution.error),
    hasMergeConflict: Boolean(task.execution.mergeConflict),
  });

  // Increment counter FIRST (before any delta can re-trigger)
  persistence.updateTask(taskId, { execution: { autoFixAttempts: attempts } });

  const agentSelection = resolveAutoFixAgent(deps.getAutoFixAgent?.());
  let persistedSavedError: string | undefined;
  let lineage: TaskLineageSnapshot | undefined;
  try {
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-agent-selected',
      configuredAutoFixAgent: agentSelection.configuredAutoFixAgent ?? null,
      selectedAgent: agentSelection.selectedAgent,
      selectedAgentSource: agentSelection.selectedAgentSource,
      fallbackChain: agentSelection.fallbackChain,
    });
    persistence.appendTaskOutput(
      taskId,
      `\n[Auto-fix Agent] selected=${agentSelection.selectedAgent} source=${agentSelection.selectedAgentSource} fallback=${agentSelection.fallbackChain}`,
    );
    const route = recoveryRoute.kind;
    console.log(
      `[auto-fix-route] task="${taskId}" route=${route} agent=${agentSelection.selectedAgent} source=${agentSelection.selectedAgentSource}`,
    );
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-route-selected',
      route,
      agent: agentSelection.selectedAgent,
      selectedAgentSource: agentSelection.selectedAgentSource,
      configuredAutoFixAgent: agentSelection.configuredAutoFixAgent ?? null,
      fallbackChain: agentSelection.fallbackChain,
      outputLength: recoveryRoute.kind === 'recreateWorkflowFromFreshBase'
        ? null
        : persistence.getTaskOutput(taskId).length,
    });
    if (recoveryRoute.kind === 'recreateWorkflowFromFreshBase') {
      persistence.appendTaskOutput(
        taskId,
        `\n[Auto-fix] Startup merge conflict detected; recreating workflow ${recoveryRoute.workflowId} from a fresh base.`,
      );
      const started = await recreateWorkflowFromFreshBase(recoveryRoute.workflowId, {
        logger: deps.logger,
        orchestrator,
        persistence,
        commandService: deps.commandService,
        taskExecutor,
        mutationTiming: deps.mutationTiming,
      });
      const runnable = started.filter(isDispatchableLaunch);
      persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'auto-fix-post-route-recreate-workflow',
        workflowId: recoveryRoute.workflowId,
        startedCount: started.length,
        runnableCount: runnable.length,
        startedStatuses: started.map((candidate) => candidate.status),
      });
      if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
      return;
    }

    const workspacePath = task.execution.workspacePath?.trim();
    if (!workspacePath) {
      const skipReason =
        `Auto-fix skipped: task "${taskId}" has no valid workspacePath; `
        + `run recreate-task or recreate-workflow first.`;
      persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'auto-fix-skip-no-workspace',
        route: recoveryRoute.kind,
        attempts,
        maxRetries: max,
      });
      persistence.appendTaskOutput(taskId, `\n[Auto-fix] ${skipReason}`);
      return;
    }

    ({ savedError: persistedSavedError } = orchestrator.beginConflictResolution(taskId));
    lineage = captureTaskLineage(taskId, orchestrator);
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-begin-conflict-resolution',
      savedErrorLength: persistedSavedError.length,
    });
    if (recoveryRoute.kind === 'resolveConflict') {
      await taskExecutor.resolveConflict(taskId, persistedSavedError, agentSelection.selectedAgent);
    } else {
      const output = persistence.getTaskOutput(taskId);
      await taskExecutor.fixWithAgent(taskId, output, agentSelection.selectedAgent, persistedSavedError);
    }
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    const postRouteStrategy = selectAutoFixPostRouteStrategy(task);
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-post-route-strategy-selected',
      strategy: postRouteStrategy,
    });
    if (postRouteStrategy === 'resume_from_fixed_tip') {
      await recordFixedIntegrationAnchor(taskId, task, {
        persistence,
        taskExecutor,
        orchestrator,
        lineage,
        signal: deps.signal,
      });
      assertLineageCurrent(lineage, orchestrator, deps.signal);
      const finalizeResult = await finalizeAppliedFix(taskId, persistedSavedError, {
        orchestrator,
        taskExecutor,
        autoApproveAIFixes: deps.getAutoApproveAIFixes?.() ?? true,
      }, deps.signal, lineage);
      persistence.logEvent?.(taskId, 'debug.auto-fix', {
        phase: 'auto-fix-post-route-finalize',
        autoApproved: finalizeResult.autoApproved,
        startedCount: finalizeResult.started.length,
        startedStatuses: finalizeResult.started.map((t) => t.status),
      });
      const latestTask = orchestrator.getTask(taskId);
      if (latestTask?.status === 'failed' && orchestrator.shouldAutoFix(taskId) && inlineRetryDepth < 1) {
        persistence.logEvent?.(taskId, 'debug.auto-fix', {
          phase: 'auto-fix-post-route-inline-retry',
          reason: 'post-fix-publish-failed',
          inlineRetryDepth,
          latestError: latestTask.execution.error ?? null,
        });
        await autoFixOnFailure(taskId, deps, inlineRetryDepth + 1);
      }
      return;
    }
    assertLineageCurrent(lineage, orchestrator, deps.signal);
    const started = await runTaskInvalidationThroughCommandService(
      taskId,
      'retryTask',
      {
        logger: deps.logger,
        orchestrator,
        persistence,
        commandService: deps.commandService,
        taskExecutor,
        mutationTiming: deps.mutationTiming,
      },
      'workflow-actions.autoFixOnFailure.retryTask.applyInvalidation',
    );
    const runnable = started.filter(isDispatchableLaunch);
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-post-route-restart',
      startedCount: started.length,
      runnableCount: runnable.length,
      startedStatuses: started.map(t => t.status),
    });
    if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
  } catch (err) {
    if (err instanceof StaleLineageError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const diagnostics = formatAutoFixDiagnostics(err);
    if (lineage) assertLineageCurrent(lineage, orchestrator, deps.signal);
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-route-failed',
      errorType: err instanceof Error ? err.name : typeof err,
      errorMessage: msg,
      configuredAutoFixAgent: agentSelection.configuredAutoFixAgent ?? null,
      selectedAgent: agentSelection.selectedAgent,
      selectedAgentSource: agentSelection.selectedAgentSource,
      fallbackChain: agentSelection.fallbackChain,
      diagnostics: diagnostics ?? null,
    });
    if (diagnostics) {
      persistence.appendTaskOutput(taskId, `\n[Auto-fix Diagnostics]\n${diagnostics}`);
    }
    persistence.appendTaskOutput(taskId, `\n[Auto-fix] Agent failed (attempt ${attempts}/${max}): ${msg}`);
    const detailedMsg = diagnostics ? `${msg}\n\n${diagnostics}` : msg;
    if (persistedSavedError !== undefined) {
      if (lineage) assertLineageCurrent(lineage, orchestrator, deps.signal);
      orchestrator.revertConflictResolution(taskId, persistedSavedError, detailedMsg);
    }
  }
}
