import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export type WorkflowCancelResult = {
  cancelled: string[];
  runningCancelled: string[];
};

export type WorkflowPreemptionFenceKind = 'recreate' | 'delete';

type PreemptWorkflowExecution = (workflowId: string) => Promise<WorkflowCancelResult | void>;

function firstHeadlessArg(args: readonly unknown[]): string {
  const payload = args[0] as { args?: readonly unknown[] } | undefined;
  const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
  return typeof rawArgs[0] === 'string' ? rawArgs[0] : '';
}

export function hardPreemptFenceKind(
  channel: string,
  args: readonly unknown[],
): WorkflowPreemptionFenceKind | null {
  if (
    channel === 'invoker:recreate-workflow'
    || channel === 'invoker:recreate-task'
    || channel === 'invoker:rebase-recreate'
  ) {
    return 'recreate';
  }
  if (
    channel === 'invoker:delete-workflow'
    || channel === 'invoker:delete-all-workflows'
    || channel === 'invoker:delete-all-workflows-bulk'
  ) {
    return 'delete';
  }
  if (channel !== 'headless.exec') {
    return null;
  }
  const command = firstHeadlessArg(args);
  if (
    command === 'recreate'
    || command === 'recreate-workflow'
    || command === 'recreate-task'
    || command === 'rebase-recreate'
  ) {
    return 'recreate';
  }
  if (
    command === 'delete'
    || command === 'delete-workflow'
    || command === 'delete-all'
  ) {
    return 'delete';
  }
  return null;
}

export function isFixLikeWorkflowMutation(channel: string, args: readonly unknown[]): boolean {
  if (channel === 'invoker:fix-with-agent' || channel === 'invoker:resolve-conflict') {
    return true;
  }
  if (channel !== 'headless.exec') {
    return false;
  }
  const command = firstHeadlessArg(args);
  return command === 'fix' || command === 'resolve-conflict';
}

export async function preemptWorkflowBeforeMutation(
  workflowId: string,
  deps: {
    preemptWorkflowExecution: PreemptWorkflowExecution;
    logger?: Logger;
    context: string;
    mutationTiming?: WorkflowMutationTiming;
  },
): Promise<WorkflowCancelResult> {
  deps.logger?.info(`preempt begin context="${deps.context}" workflow="${workflowId}"`, { module: 'preempt' });
  const raw = deps.mutationTiming
    ? await deps.mutationTiming.span(
      'preemptWorkflowBeforeMutation',
      { context: deps.context },
      () => deps.preemptWorkflowExecution(workflowId),
    )
    : await deps.preemptWorkflowExecution(workflowId);
  const result: WorkflowCancelResult = raw ?? { cancelled: [], runningCancelled: [] };
  deps.mutationTiming?.mark('preemptWorkflowBeforeMutation.result', 'completed', {
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
