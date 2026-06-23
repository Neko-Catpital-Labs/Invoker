/**
 * Prepare phase — builds the {@link WorkRequest} for a task launch.
 *
 * Gathers upstream context, collects upstream branches and reconciliation
 * alternatives, enforces the dependency-branch guard, computes the lifecycle
 * tag / base commit, and assembles the request (including the early
 * branch-persistence `onBranchResolved` callback). Pure construction — it does
 * not select or start an executor.
 */

import { randomUUID } from 'node:crypto';

import type { TaskState } from '@invoker/workflow-core';
import type { WorkRequest } from '@invoker/contracts';

import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { formatLifecycleTag, extractAttemptSuffix } from './branch-utils.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import type { TaskRunnerPhaseHost } from './task-runner-phase-host.js';

export async function buildWorkRequest(
  host: TaskRunnerPhaseHost,
  args: {
    task: TaskState;
    attemptId: string;
    bench: (phase: string, metadata?: Record<string, unknown>) => void;
  },
): Promise<WorkRequest> {
  const { task, attemptId, bench } = args;

  traceExecution(
    `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} (past pivot check) → gather upstreams + build WorkRequest`,
  );

  // Gather upstream context from completed dependencies
  bench('buildUpstreamContext.start');
  const upstreamContext = await host.buildUpstreamContext(task);
  bench('buildUpstreamContext.end', {
    upstreamContextCount: upstreamContext.length,
  });
  bench('collectUpstreamBranches.start');
  const upstreamBranches = host.collectUpstreamBranches(task);
  bench('collectUpstreamBranches.end', {
    upstreamBranchCount: upstreamBranches.length,
  });
  bench('buildAlternatives.start');
  const alternatives = host.buildAlternatives(task);
  bench('buildAlternatives.end', {
    alternativeCount: alternatives.length,
  });

  // Guard: every completed dependency (local or external) must have branch metadata.
  // Without it the downstream worktree would run against bare base branch,
  // silently dropping all upstream implementation changes.
  // Skip for merge nodes: they collect branches from the full workflow, not just direct deps.
  if (!task.config.isMergeNode) {
    for (const depId of task.dependencies) {
      const dep = host.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed' && !dep.execution.branch) {
        throw new Error(
          `Task "${task.id}": dependency "${depId}" completed without branch metadata` +
          ` — upstream changes would be silently dropped. The plan may need to be restarted.`,
        );
      }
    }
    for (const depRef of task.config.externalDependencies ?? []) {
      const dep = host.resolveExternalDependencyTask(depRef.workflowId, depRef.taskId);
      if (dep && dep.status === 'completed' && !dep.execution.branch) {
        throw new Error(
          `Task "${task.id}": external dependency "${depRef.workflowId}/${depRef.taskId}" completed without branch metadata` +
          ` — upstream changes would be silently dropped. The plan may need to be restarted.`,
        );
      }
    }
  }
  bench('dependencyBranchGuard.end');

  // Read workflow + task generations to build the visible lifecycle tag that
  // is appended to every experiment branch name. Lifecycle uniqueness lives
  // in the branch *name* (via `formatLifecycleTag`), not in the content hash
  // — so two recreates of the same spec produce the same content fingerprint
  // (cache-equivalent) but distinct branch names (collision-free).
  const workflow = task.config.workflowId ? host.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
  const workflowGeneration = (workflow as any)?.generation ?? 0;
  const taskExecutionGeneration = task.execution.generation ?? 0;
  const lifecycleTag = formatLifecycleTag({
    wfGen: workflowGeneration,
    taskGen: taskExecutionGeneration,
    attemptShort: extractAttemptSuffix(attemptId, task.id),
  });
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch;
  const repoUrl = workflow?.repoUrl;
  const branchRepoUrl = workflow?.intermediateRepoUrl?.trim() || undefined;
  const freshBase = task.config.workflowId ? host.freshBaseCommits.get(task.config.workflowId) : undefined;
  const baseCommit = freshBase && freshBase.branch === baseBranch ? freshBase.commit : undefined;

  // Persist the experiment branch as soon as the executor knows it — well
  // before `git worktree add` could leak a worktree without a recorded branch
  // on the attempt row. Reconciliation paths can then observe the branch
  // even if the executor crashes mid-startup.
  let branchPersistedEarly = false;
  const startGeneration = task.execution.generation ?? 0;
  const onBranchResolved = (branch: string): void => {
    if (!branch || branchPersistedEarly) return;
    // Skip if the task has moved to a newer attempt/generation.
    if (host.isLaunchStale(task.id, attemptId, startGeneration)) return;
    branchPersistedEarly = true;
    try {
      host.persistence.updateAttempt?.(attemptId, { branch } as any);
      host.persistence.updateTask(task.id, {
        execution: { branch } as any,
      });
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} branch persisted early branch=${branch}`,
      );
    } catch (err) {
      // Early persistence is best-effort: the post-start path persists the
      // same field again, so a transient failure here is not fatal.
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} early branch persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const actionType = host.determineActionType(task);
  const executionAgent = task.config.executionAgent?.trim() || DEFAULT_EXECUTION_AGENT;
  const request: WorkRequest = {
    requestId: randomUUID(),
    actionId: task.id,
    attemptId,
    executionGeneration: task.execution.generation ?? 0,
    actionType,
    inputs: {
      description: task.description,
      command: task.config.command,
      prompt: task.config.prompt,
      executionAgent,
      repoUrl,
      branchRepoUrl,
      featureBranch: task.config.featureBranch,
      upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
      lifecycleTag,
      baseBranch,
      baseCommit,
      freshWorkspace: host.shouldUseFreshWorkspace(task),
      reusableWorktree: task.execution.branch && task.execution.workspacePath
        ? {
          branch: task.execution.branch,
          workspacePath: task.execution.workspacePath,
        }
        : undefined,
    },
    callbackUrl: '',
    timestamps: {
      createdAt: new Date().toISOString(),
    },
    onBranchResolved,
  };
  bench('workRequest.built', {
    actionType: request.actionType,
    hasRepoUrl: Boolean(request.inputs.repoUrl),
    upstreamBranchCount: upstreamBranches.length,
  });

  traceExecution(
    `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} WorkRequest built actionType=${request.actionType} repoUrl=${request.inputs.repoUrl ?? '(none)'} upstreamBranches=${JSON.stringify(request.inputs.upstreamBranches ?? [])}`,
  );

  return request;
}
