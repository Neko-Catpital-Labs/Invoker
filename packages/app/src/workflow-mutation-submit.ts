import type { Logger, WorkflowMutationAcceptedResult } from '@invoker/contracts';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';

export interface WorkflowMutationSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface SubmitWorkflowMutationOptions {
  workflowExists: (workflowId: string) => boolean;
  coordinator: WorkflowMutationSubmitter;
  logger?: Pick<Logger, 'info'>;
  deferDrain?: boolean;
}

function isMissingWorkflowDelete(channel: string, workflowId: string, args: unknown[]): boolean {
  if (channel === 'invoker:delete-workflow') {
    return args[0] === workflowId;
  }
  if (channel !== 'headless.exec') {
    return false;
  }
  const payload = args[0] as { args?: unknown[] } | undefined;
  const command = payload?.args?.[0];
  return Array.isArray(payload?.args)
    && (command === 'delete' || command === 'delete-workflow')
    && payload.args[1] === workflowId;
}

function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return sqliteError.errcode === 787
    || sqliteError.message.includes('FOREIGN KEY constraint failed');
}

function acceptedAlreadyDeleted(
  workflowId: string,
  channel: string,
  logger?: Pick<Logger, 'info'>,
): WorkflowMutationAcceptedResult {
  logger?.info(`delete-workflow ignored missing workflow="${workflowId}"`, { module: 'workflow-mutation' });
  return { ok: true, accepted: true, intentId: 0, workflowId, channel };
}

export function submitWorkflowMutationOrAcknowledgeDeleted(
  workflowId: string,
  priority: WorkflowMutationPriority,
  channel: string,
  args: unknown[],
  options: SubmitWorkflowMutationOptions,
): WorkflowMutationAcceptedResult {
  if (isMissingWorkflowDelete(channel, workflowId, args) && !options.workflowExists(workflowId)) {
    return acceptedAlreadyDeleted(workflowId, channel, options.logger);
  }

  try {
    const intentId = options.coordinator.submit(workflowId, priority, channel, args, {
      deferDrain: options.deferDrain,
    });
    return { ok: true, accepted: true, intentId, workflowId, channel };
  } catch (error) {
    if (
      isMissingWorkflowDelete(channel, workflowId, args)
      && isForeignKeyConstraintError(error)
      && !options.workflowExists(workflowId)
    ) {
      return acceptedAlreadyDeleted(workflowId, channel, options.logger);
    }
    throw error;
  }
}
