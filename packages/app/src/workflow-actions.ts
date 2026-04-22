/**
 * Shared workflow action functions used by headless, GUI, and Slack surfaces.
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
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { normalizeMergeModeForPersistence } from './merge-mode.js';

// ── Deps interfaces ──────────────────────────────────────────

export interface ActionDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  /** @deprecated Pool cleanup uses the workflow mirror; repoRoot branch deletion is no longer used. */
  repoRoot?: string;
  /** When set, rebase-and-refreshes the pool mirror and removes managed branches before bumping generation. */
  taskExecutor?: TaskRunner;
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
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
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
    (task.config.isMergeNode || isMergeConflictError(task.execution.pendingFixError ?? ''));
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
    const runnable = started.filter(
      (t) => t.status === 'running' && !(t.config.isMergeNode && t.id === taskId),
    );
    if (runnable.length > 0) {
      await deps.taskExecutor.executeTasks(runnable);
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

export function restartTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.restartTask(taskId);
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

export function recreateTask(
  taskId: string,
  deps: Pick<ActionDeps, 'persistence' | 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.recreateTask(taskId);
}

export function cancelWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): { cancelled: string[]; runningCancelled: string[] } {
  return deps.orchestrator.cancelWorkflow(workflowId);
}

/**
 * Rebase-and-retry: refresh the pool mirror / origin base, remove managed
 * experiment/invoker branches in that mirror, bump generation, and restart the DAG.
 *
 * When `taskExecutor` is provided, `preparePoolForRebaseRetry` runs first; the
 * caller then executes runnable tasks (normal pool fetch + origin base resolution apply).
 */
export async function rebaseAndRetry(
  taskId: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const task = deps.orchestrator.getTask(taskId);
  if (!task?.config.workflowId) throw new Error(`Task ${taskId} not found or has no workflow`);
  const workflowId = task.config.workflowId;

  const workflow = deps.persistence.loadWorkflow(workflowId);
  deps.logger?.info(
    `rebaseAndRetry: taskId=${taskId} workflowId=${workflowId} → pool prep (if taskExecutor+repoUrl) → bumpGenerationAndRecreate → recreateWorkflow`,
    { module: 'agent-session-trace' },
  );
  if (deps.taskExecutor && workflow?.repoUrl) {
    await deps.taskExecutor.preparePoolForRebaseRetry(
      workflowId,
      workflow.repoUrl,
      workflow.baseBranch,
    );
  }

  return bumpGenerationAndRecreate(workflowId, deps);
}

export interface BuildCancelInFlightDeps {
  orchestrator: Orchestrator;
  taskExecutor?: TaskRunner;
}

export function buildCancelInFlight(deps: BuildCancelInFlightDeps): CancelInFlightFn {
  return async (scope: InvalidationScope, id: string): Promise<void> => {
    if (scope === 'none') return;
    const result =
      scope === 'task'
        ? deps.orchestrator.cancelTask(id)
        : deps.orchestrator.cancelWorkflow(id);
    const taskExecutor = deps.taskExecutor;
    if (!taskExecutor) return;
    for (const runningId of result.runningCancelled) {
      await taskExecutor.killActiveExecution(runningId);
    }
  };
}

export function buildInvalidationDeps(
  deps: Pick<ActionDeps, 'logger' | 'orchestrator' | 'persistence' | 'taskExecutor'>,
): InvalidationDeps {
  const cancelInFlight = buildCancelInFlight({
    orchestrator: deps.orchestrator,
    taskExecutor: deps.taskExecutor,
  });
  return {
    cancelInFlight,
    retryTask: (taskId: string) => deps.orchestrator.restartTask(taskId),
    recreateTask: (taskId: string) => deps.orchestrator.recreateTask(taskId),
    retryWorkflow: (workflowId: string) => deps.orchestrator.retryWorkflow(workflowId),
    recreateWorkflow: (workflowId: string) =>
      bumpGenerationAndRecreate(workflowId, {
        logger: deps.logger,
        orchestrator: deps.orchestrator,
        persistence: deps.persistence,
      }),
  };
}

export function editTaskCommand(
  taskId: string,
  newCommand: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskCommand(taskId, newCommand);
}

/**
 * Edit a task's prompt — recreate-class invalidation route per Step 3 of
 * `docs/architecture/task-invalidation-roadmap.md` and the Decision Table
 * row "Edit `prompt`" in `docs/architecture/task-invalidation-chart.md`
 * (`prompt` mutation → `recreateTask` / task scope, mirroring Step 2's
 * `command` mutation).
 *
 * The substantive routing — cancel-first interruption of any active
 * attempt, prompt persistence, lineage discard via `recreateTask`,
 * generation bump — lives in `Orchestrator.editTaskPrompt`. That method
 * is the synchronous orchestrator-internal seam of `applyInvalidation`'s
 * Hard Invariant (cancel BEFORE authoritative reset) and reuses
 * `recreateTask`'s reset shape so stale lineage (branch, commit,
 * workspacePath, agentSessionId, containerId, error, exitCode, ...) is
 * always cleared.
 *
 * This wrapper deliberately stays a thin sync delegate to keep the public
 * surface (signature and return shape) backward compatible for headless,
 * GUI, and Slack callers (e.g. `api-server` POST `/api/tasks/:id/edit-prompt`
 * and `headless set prompt <taskId> <text>`). Executor-aware kill of
 * active in-flight runs (`taskExecutor.killActiveExecution`) flows
 * through the same path Step 1 scaffolded (`buildCancelInFlight` /
 * `buildInvalidationDeps`) and Step 17 will promote into a first-class
 * lifecycle command surface; for now the orchestrator-side cancel inside
 * `editTaskPrompt` is sufficient because executor processes observe the
 * cancellation through the cancelled attempt and the bumped execution
 * generation when they next report progress.
 *
 * Cancel-first is enforced inside the orchestrator method — this wrapper
 * MUST NOT add a parallel cancel call.
 */
export function editTaskPrompt(
  taskId: string,
  newPrompt: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskPrompt(taskId, newPrompt);
}

export function editTaskType(
  taskId: string,
  executorType: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  remoteTargetId?: string,
): TaskState[] {
  return deps.orchestrator.editTaskType(taskId, executorType, remoteTargetId);
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
 * Persist merge mode and re-run the merge
 * gate when it was already finished or waiting, matching GUI `invoker:set-merge-mode`.
 */
export async function setWorkflowMergeMode(
  workflowId: string,
  mergeMode: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskRunner },
): Promise<void> {
  const normalized = normalizeMergeModeForPersistence(mergeMode);
  deps.persistence.updateWorkflow(workflowId, { mergeMode: normalized });
  const tasks = deps.persistence.loadTasks(workflowId);
  const mergeTask = tasks.find((t) => t.config.isMergeNode);
  if (
    mergeTask &&
    (mergeTask.status === 'completed' || mergeTask.status === 'awaiting_approval' || mergeTask.status === 'review_ready')
  ) {
    const started = deps.orchestrator.restartTask(mergeTask.id);
    const runnable = started.filter((t) => t.status === 'running');
    await deps.taskExecutor.executeTasks(runnable);
  }
}

export async function resolveConflictAction(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence' | 'autoApproveAIFixes'> & { taskExecutor: TaskRunner },
  agentName?: string,
): Promise<{ autoApproved: boolean; started: TaskState[] }> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const { savedError } = orchestrator.beginConflictResolution(taskId);
  try {
    await taskExecutor.resolveConflict(taskId, savedError, agentName);
    return await finalizeAppliedFix(taskId, savedError, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    persistence.appendTaskOutput(taskId, `\n[Resolve Conflict] Failed: ${msg}`);
    orchestrator.revertConflictResolution(taskId, savedError, msg);
    throw err;
  }
}

export async function finalizeAppliedFix(
  taskId: string,
  savedError: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'autoApproveAIFixes'> & { taskExecutor: TaskRunner },
): Promise<{ autoApproved: boolean; started: TaskState[] }> {
  deps.orchestrator.setFixAwaitingApproval(taskId, savedError);
  if (!deps.autoApproveAIFixes) {
    return { autoApproved: false, started: [] };
  }

  const { started } = await approveTask(taskId, deps);
  return { autoApproved: true, started };
}

// ── Auto-fix helpers ─────────────────────────────────────────

function isMergeConflictError(error: string): boolean {
  for (const c of [error, error.trim(), error.split('\n\n').at(-1)?.trim() ?? '']) {
    if (!c) continue;
    try { if ((JSON.parse(c) as any)?.type === 'merge_conflict') return true; } catch { /* not JSON */ }
    const jsonStart = c.indexOf('{');
    if (jsonStart >= 0) {
      try {
        if ((JSON.parse(c.slice(jsonStart)) as any)?.type === 'merge_conflict') return true;
      } catch {
        /* not parseable JSON tail */
      }
    }
    if (c.includes('CONFLICT (') || c.includes('Automatic merge failed')) {
      return true;
    }
  }
  return false;
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
  },
): Promise<void> {
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
    orchestrator: Orchestrator;
    persistence: SQLiteAdapter;
    taskExecutor: TaskRunner;
    getAutoFixAgent?: () => string | undefined;
    getAutoApproveAIFixes?: () => boolean | undefined;
  },
  inlineRetryDepth = 0,
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  if (!orchestrator.shouldAutoFix(taskId)) return;

  const task = orchestrator.getTask(taskId);
  if (!task || task.status !== 'failed') return;

  const attempts = (task.execution.autoFixAttempts ?? 0) + 1;
  const max = orchestrator.getAutoFixRetryBudget(taskId);
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

  const { savedError } = orchestrator.beginConflictResolution(taskId);
  const agentSelection = resolveAutoFixAgent(deps.getAutoFixAgent?.());
  persistence.logEvent?.(taskId, 'debug.auto-fix', {
    phase: 'auto-fix-begin-conflict-resolution',
    savedErrorLength: savedError.length,
  });
  try {
    const output = persistence.getTaskOutput(taskId);
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
    const useResolveConflict = isMergeConflictError(savedError);
    const route = useResolveConflict ? 'resolveConflict' : 'fixWithAgent';
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
      outputLength: output.length,
    });
    if (useResolveConflict) {
      await taskExecutor.resolveConflict(taskId, savedError, agentSelection.selectedAgent);
    } else {
      await taskExecutor.fixWithAgent(taskId, output, agentSelection.selectedAgent, savedError);
    }
    const postRouteStrategy = selectAutoFixPostRouteStrategy(task);
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-post-route-strategy-selected',
      strategy: postRouteStrategy,
    });
    if (postRouteStrategy === 'resume_from_fixed_tip') {
      await recordFixedIntegrationAnchor(taskId, task, {
        persistence,
        taskExecutor,
      });
      const finalizeResult = await finalizeAppliedFix(taskId, savedError, {
        orchestrator,
        taskExecutor,
        autoApproveAIFixes: deps.getAutoApproveAIFixes?.() ?? true,
      });
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
    const started = orchestrator.restartTask(taskId);
    const runnable = started.filter(t => t.status === 'running');
    persistence.logEvent?.(taskId, 'debug.auto-fix', {
      phase: 'auto-fix-post-route-restart',
      startedCount: started.length,
      runnableCount: runnable.length,
      startedStatuses: started.map(t => t.status),
    });
    if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diagnostics = formatAutoFixDiagnostics(err);
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
    orchestrator.revertConflictResolution(taskId, savedError, detailedMsg);
  }
}
