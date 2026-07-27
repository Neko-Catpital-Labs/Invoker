import { normalizeWorkflowBaseBranch, workflowBaseBranchNeedsMigration } from '@invoker/workflow-core';
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
    if (!workflowBaseBranchNeedsMigration(workflow.baseBranch, 'master')) continue;
    persistence.updateWorkflow(workflow.id, {
      baseBranch: normalizeWorkflowBaseBranch(workflow.baseBranch, 'master'),
    });
    updated += 1;
  }
  if (updated > 0) {
    logger?.info?.(
      `[init] normalized ${updated} workflow base branch ref${updated === 1 ? '' : 's'} to canonical form`,
      { module: 'init', workflowCount: updated },
    );
  }
  return updated;
}
