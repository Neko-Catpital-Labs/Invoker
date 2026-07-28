import { normalizeWorkflowBaseBranch, PINNED_WORKFLOW_BASE_BRANCH, workflowBaseBranchNeedsMigration } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

interface WorkflowBaseBranchLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
}

export function normalizePersistedWorkflowBaseBranches(
  persistence: Pick<SQLiteAdapter, 'listWorkflows' | 'updateWorkflow'>,
  logger?: WorkflowBaseBranchLogger,
): number {
  let updated = 0;
  for (const workflow of persistence.listWorkflows()) {
    if (!workflowBaseBranchNeedsMigration(workflow.baseBranch)) continue;
    persistence.updateWorkflow(workflow.id, {
      baseBranch: normalizeWorkflowBaseBranch(workflow.baseBranch),
    });
    updated += 1;
  }
  if (updated > 0) {
    logger?.info?.(
      `[init] normalized ${updated} workflow base branch${updated === 1 ? '' : 'es'} to ${PINNED_WORKFLOW_BASE_BRANCH}`,
      { module: 'init', workflowCount: updated, baseBranch: PINNED_WORKFLOW_BASE_BRANCH },
    );
  }
  return updated;
}
