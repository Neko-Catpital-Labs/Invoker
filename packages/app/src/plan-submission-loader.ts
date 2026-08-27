import type { Logger } from '@invoker/contracts';
import { PINNED_WORKFLOW_BASE_BRANCH, type PlanDefinition } from '@invoker/workflow-core';
import { backupPlan } from './plan-backup.js';

export interface PlanSubmissionLoadResult {
  planName: string;
  workflowId: string;
  workflowIds?: string[];
  workflowCount?: number;
}

export interface PlanSubmissionLoadDeps {
  persistence: {
    listWorkflows(): Array<{ id: string; featureBranch?: string; staged?: boolean }>;
    updateWorkflow(workflowId: string, changes: { staged: boolean }): void;
  };
  orchestrator: { loadPlan(plan: PlanDefinition, opts: { allowGraphMutation?: boolean; staged?: boolean }): void };
  allowGraphMutation?: boolean;
  logger?: Logger;
}

export interface PlanSubmissionLoadOptions {
  logLabel?: string;
  preserveTaskHandles?: boolean;
  taskHandles?: { clear(): void };
  staged?: boolean;
}

export async function loadPlanSubmissionBundle(
  planText: string,
  deps: PlanSubmissionLoadDeps,
  options?: PlanSubmissionLoadOptions,
): Promise<PlanSubmissionLoadResult> {
  const { applyConfiguredPlanDefaults, parsePlanSubmissionBundle } = await import('./plan-parser.js');
  const submission = parsePlanSubmissionBundle(planText);
  const existingWorkflowIds = new Set(deps.persistence.listWorkflows().map((workflow) => workflow.id));
  const loadedWorkflowIds: string[] = [];
  let upstream: { workflowId: string; featureBranch: string } | undefined;

  if (options?.logLabel) {
    deps.logger?.info(
      `${options.logLabel}: loading "${submission.name}" (${submission.plans.length} workflow${submission.plans.length === 1 ? '' : 's'})`,
      { module: 'ipc' },
    );
  }
  if (options?.taskHandles && !options.preserveTaskHandles) {
    options.taskHandles.clear();
  }

  for (const parsedPlan of submission.plans) {
    let plan = applyConfiguredPlanDefaults(parsedPlan);
    if (!submission.isStack) {
      plan = { ...plan, baseBranch: PINNED_WORKFLOW_BASE_BRANCH };
    }
    if (upstream) {
      plan = {
        ...plan,
        baseBranch: upstream.featureBranch,
        externalDependencies: [
          ...(plan.externalDependencies ?? []),
          {
            workflowId: upstream.workflowId,
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
          } as const,
        ],
      };
    }
    backupPlan(plan, undefined, deps.logger);
    deps.orchestrator.loadPlan(plan, { allowGraphMutation: deps.allowGraphMutation, staged: options?.staged });
    const workflow = deps.persistence.listWorkflows().find((candidate) => !existingWorkflowIds.has(candidate.id));
    if (!workflow) {
      throw new Error('Loaded plan did not create a workflow.');
    }
    if (options?.staged && workflow.staged !== true) {
      deps.persistence.updateWorkflow(workflow.id, { staged: true });
    }
    existingWorkflowIds.add(workflow.id);
    loadedWorkflowIds.push(workflow.id);
    upstream = { workflowId: workflow.id, featureBranch: workflow.featureBranch ?? plan.featureBranch ?? plan.baseBranch ?? 'main' };
  }

  const workflowId = loadedWorkflowIds[loadedWorkflowIds.length - 1];
  if (!workflowId) {
    throw new Error('Loaded plan did not create a workflow.');
  }
  return {
    planName: submission.name,
    workflowId,
    workflowIds: loadedWorkflowIds,
    workflowCount: loadedWorkflowIds.length,
  };
}
