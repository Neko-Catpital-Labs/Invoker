import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import type { WorkflowMutationContext } from './workflow-mutation-coordinator.js';

export type WorkflowCancelResult = {
  cancelled: string[];
  runningCancelled: string[];
};

type PreemptWorkflowExecution = (workflowId: string) => Promise<WorkflowCancelResult | void>;

function throwIfMutationAborted(context: WorkflowMutationContext | undefined, stage: string): void {
  if (!context?.signal.aborted) {
    return;
  }
  const reason = context.signal.reason;
  const detail = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
  throw new Error(`Workflow mutation ${stage} aborted: ${detail}`);
}

export async function preemptWorkflowBeforeMutation(
  workflowId: string,
  deps: {
    preemptWorkflowExecution: PreemptWorkflowExecution;
    logger?: Logger;
    context: string;
    mutationTiming?: WorkflowMutationTiming;
    mutationContext?: WorkflowMutationContext;
  },
): Promise<WorkflowCancelResult> {
  throwIfMutationAborted(deps.mutationContext, `${deps.context}.before-preempt`);
  deps.logger?.info(`preempt begin context="${deps.context}" workflow="${workflowId}"`, { module: 'preempt' });
  const timing = deps.mutationContext?.mutationTiming ?? deps.mutationTiming;
  const raw = timing
    ? await timing.span(
      'preemptWorkflowBeforeMutation',
      { context: deps.context },
      () => deps.preemptWorkflowExecution(workflowId),
    )
    : await deps.preemptWorkflowExecution(workflowId);
  const result: WorkflowCancelResult = raw ?? { cancelled: [], runningCancelled: [] };
  throwIfMutationAborted(deps.mutationContext, `${deps.context}.after-preempt`);
  timing?.mark('preemptWorkflowBeforeMutation.result', 'completed', {
    context: deps.context,
    cancelledCount: result.cancelled.length,
    runningCancelledCount: result.runningCancelled.length,
  });
  deps.logger?.info(
    `preempt end context="${deps.context}" workflow="${workflowId}" cancelled=${result.cancelled.length} runningCancelled=${result.runningCancelled.length}`,
    { module: 'preempt' },
  );
  return result;
}
