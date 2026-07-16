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

const MISSING_WORKFLOW_IDEMPOTENT_WORKFLOW_COMMANDS = new Set([
  'delete',
  'delete-workflow',
  'retry',
  'recreate',
]);

const MISSING_WORKFLOW_IDEMPOTENT_TASK_COMMANDS = new Set([
  'retry-task',
  'recreate-task',
]);

function headlessExecCommand(args: unknown[]): string | undefined {
  const payload = args[0] as { args?: unknown[] } | undefined;
  const command = payload?.args?.[0];
  return typeof command === 'string' ? command : undefined;
}

function taskTargetBelongsToWorkflow(target: unknown, workflowId: string): boolean {
  if (typeof target !== 'string') {
    return false;
  }
  return target.startsWith(`${workflowId}/`);
}

function isMissingWorkflowIdempotentMutation(channel: string, workflowId: string, args: unknown[]): boolean {
  if (
    channel === 'invoker:delete-workflow'
    || channel === 'invoker:retry-workflow'
    || channel === 'invoker:recreate-workflow'
  ) {
    return args[0] === workflowId;
  }
  if (channel !== 'headless.exec') {
    return false;
  }
  const payload = args[0] as { args?: unknown[] } | undefined;
  const command = headlessExecCommand(args);
  if (!command || !Array.isArray(payload?.args)) {
    return false;
  }
  if (MISSING_WORKFLOW_IDEMPOTENT_WORKFLOW_COMMANDS.has(command)) {
    return payload.args[1] === workflowId;
  }
  if (MISSING_WORKFLOW_IDEMPOTENT_TASK_COMMANDS.has(command)) {
    return taskTargetBelongsToWorkflow(payload.args[1], workflowId);
  }
  return false;
}

function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return sqliteError.errcode === 787
    || sqliteError.message.includes('FOREIGN KEY constraint failed');
}

function acceptedMissingWorkflow(
  workflowId: string,
  channel: string,
  logger?: Pick<Logger, 'info'>,
): WorkflowMutationAcceptedResult {
  logger?.info(`ignored missing workflow="${workflowId}" for channel=${channel}`, { module: 'workflow-mutation' });
  return { ok: true, accepted: true, intentId: 0, workflowId, channel };
}

export function submitWorkflowMutationOrAcknowledgeDeleted(
  workflowId: string,
  priority: WorkflowMutationPriority,
  channel: string,
  args: unknown[],
  options: SubmitWorkflowMutationOptions,
): WorkflowMutationAcceptedResult {
  if (isMissingWorkflowIdempotentMutation(channel, workflowId, args) && !options.workflowExists(workflowId)) {
    return acceptedMissingWorkflow(workflowId, channel, options.logger);
  }

  try {
    const intentId = options.coordinator.submit(workflowId, priority, channel, args, {
      deferDrain: options.deferDrain,
    });
    return { ok: true, accepted: true, intentId, workflowId, channel };
  } catch (error) {
    if (
      isMissingWorkflowIdempotentMutation(channel, workflowId, args)
      && isForeignKeyConstraintError(error)
      && !options.workflowExists(workflowId)
    ) {
      return acceptedMissingWorkflow(workflowId, channel, options.logger);
    }
    throw error;
  }
}
