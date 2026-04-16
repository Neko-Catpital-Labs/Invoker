import type { Logger } from '@invoker/contracts';

export type WorkflowCancelResult = {
  cancelled: string[];
  runningCancelled: string[];
};

type PreemptWorkflowExecution = (workflowId: string) => Promise<WorkflowCancelResult | void>;

export async function preemptWorkflowBeforeMutation(
  workflowId: string,
  deps: {
    preemptWorkflowExecution: PreemptWorkflowExecution;
    logger?: Logger;
    context: string;
  },
): Promise<WorkflowCancelResult> {
  deps.logger?.info(`preempt begin context="${deps.context}" workflow="${workflowId}"`, { module: 'preempt' });
  const raw = await deps.preemptWorkflowExecution(workflowId);
  const result: WorkflowCancelResult = raw ?? { cancelled: [], runningCancelled: [] };
  deps.logger?.info(
    `preempt end context="${deps.context}" workflow="${workflowId}" cancelled=${result.cancelled.length} runningCancelled=${result.runningCancelled.length}`,
    { module: 'preempt' },
  );
  return result;
}
