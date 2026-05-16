import { randomUUID } from 'node:crypto';

import type { ExperimentVariant, TaskState } from '@invoker/workflow-core';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import { formatLifecycleTag, extractAttemptSuffix } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';

type TaskRunnerPhaseHost = any;
type Bench = (phase: string, metadata?: Record<string, unknown>) => void;

export type PreparedTaskExecution =
  | { kind: 'response'; response: WorkResponse }
  | { kind: 'request'; request: WorkRequest };

export async function prepareTaskExecution(
  host: TaskRunnerPhaseHost,
  task: TaskState,
  attemptId: string,
  bench: Bench,
): Promise<PreparedTaskExecution> {
  bench('executeTaskInner.begin', {
    dependencyCount: task.dependencies.length,
    externalDependencyCount: task.config.externalDependencies?.length ?? 0,
    runnerKind: task.config.runnerKind,
    poolId: task.config.poolId,
    isMergeNode: task.config.isMergeNode,
  });

  if (task.config.pivot && task.config.experimentVariants && task.config.experimentVariants.length > 0) {
    bench('executeTaskInner.pivotResponse');
    return {
      kind: 'response',
      response: {
        requestId: `req-${task.id}`,
        actionId: task.id,
        attemptId,
        executionGeneration: task.execution.generation ?? 0,
        status: 'spawn_experiments',
        outputs: {},
        dagMutation: {
          spawnExperiments: {
            description: task.description,
            variants: task.config.experimentVariants.map((v: ExperimentVariant) => ({
              id: v.id,
              description: v.description,
              prompt: v.prompt,
              command: v.command,
            })),
          },
        },
      },
    };
  }

  traceExecution(
    `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} (past pivot check) → gather upstreams + build WorkRequest`,
  );

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

  const workflow = task.config.workflowId ? host.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
  const workflowGeneration = workflow?.generation ?? 0;
  const taskExecutionGeneration = task.execution.generation ?? 0;
  const lifecycleTag = formatLifecycleTag({
    wfGen: workflowGeneration,
    taskGen: taskExecutionGeneration,
    attemptShort: extractAttemptSuffix(attemptId, task.id),
  });
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch;
  const repoUrl = workflow?.repoUrl;
  const branchRepoUrl = workflow?.intermediateRepoUrl?.trim() || undefined;

  let branchPersistedEarly = false;
  const startGeneration = task.execution.generation ?? 0;
  const onBranchResolved = (branch: string): void => {
    if (!branch || branchPersistedEarly) return;
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
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} early branch persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const request: WorkRequest = {
    requestId: randomUUID(),
    actionId: task.id,
    attemptId,
    executionGeneration: task.execution.generation ?? 0,
    actionType: host.determineActionType(task),
    inputs: {
      description: task.description,
      command: task.config.command,
      prompt: task.config.prompt,
      executionAgent: task.config.executionAgent?.trim() || DEFAULT_EXECUTION_AGENT,
      repoUrl,
      branchRepoUrl,
      featureBranch: task.config.featureBranch,
      upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
      lifecycleTag,
      baseBranch,
      freshWorkspace: host.shouldUseFreshWorkspace(task),
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

  return { kind: 'request', request };
}
