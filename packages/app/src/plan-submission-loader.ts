import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import { type Orchestrator, type PlanDefinition } from '@invoker/workflow-core';

import { backupPlan } from './plan-backup.js';
import { applyConfiguredPlanDefaults } from './plan-parser.js';

export function loadPlanSubmissionDefinitions(
  definitions: readonly PlanDefinition[],
  deps: {
    orchestrator: Orchestrator;
    persistence: SQLiteAdapter;
    logger: Logger;
    allowGraphMutation: boolean;
  },
): { workflowIds: string[]; primaryWorkflowId: string } {
  const existingWorkflowIds = new Set(deps.persistence.listWorkflows().map((workflow) => workflow.id));
  const workflowIds: string[] = [];
  let upstream: { workflowId: string; featureBranch: string } | undefined;

  for (const definition of definitions) {
    let plan = applyConfiguredPlanDefaults(definition);
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
    deps.orchestrator.loadPlan(plan, { allowGraphMutation: deps.allowGraphMutation });
    const createdWorkflow = deps.persistence.listWorkflows().find((workflow) => !existingWorkflowIds.has(workflow.id));
    if (!createdWorkflow) {
      throw new Error('Loaded plan did not create a workflow.');
    }

    existingWorkflowIds.add(createdWorkflow.id);
    workflowIds.push(createdWorkflow.id);
    upstream = {
      workflowId: createdWorkflow.id,
      featureBranch: createdWorkflow.featureBranch ?? plan.featureBranch ?? plan.baseBranch ?? 'main',
    };
  }

  const primaryWorkflowId = workflowIds[workflowIds.length - 1];
  if (!primaryWorkflowId) {
    throw new Error('Loaded plan did not create a workflow.');
  }

  return { workflowIds, primaryWorkflowId };
}
