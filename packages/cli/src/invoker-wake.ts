import type { WorkflowStatusSummary, WorkflowWaitResult } from './mcp-workflow-status.js';

export const INVOKER_WAKE_PREFIX = 'INVOKER_WAKE';
export const INVOKER_WAKE_MAX_BYTES = 2048;

export type InvokerWakePayload = {
  workflowId: string;
  settled: boolean;
  timedOut: boolean;
  status: WorkflowStatusSummary;
  reviewUrl?: string;
};

export function toInvokerWakePayload(
  result: Pick<WorkflowWaitResult, 'workflowId' | 'settled' | 'timedOut' | 'status' | 'reviewUrl'>,
): InvokerWakePayload {
  const payload: InvokerWakePayload = {
    workflowId: result.workflowId,
    settled: result.settled,
    timedOut: result.timedOut,
    status: result.status,
  };
  if (result.reviewUrl) {
    payload.reviewUrl = result.reviewUrl;
  }
  return payload;
}

export function formatInvokerWakeLine(
  result: Pick<WorkflowWaitResult, 'workflowId' | 'settled' | 'timedOut' | 'status' | 'reviewUrl'>,
): string {
  return `${INVOKER_WAKE_PREFIX} ${JSON.stringify(toInvokerWakePayload(result))}`;
}

export function assertInvokerWakeLineWithinBudget(line: string): void {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > INVOKER_WAKE_MAX_BYTES) {
    throw new Error(`INVOKER_WAKE payload exceeds ${INVOKER_WAKE_MAX_BYTES} bytes (${bytes})`);
  }
  if (line.includes('"tasks"') || line.includes('"description"')) {
    throw new Error('INVOKER_WAKE payload must not include tasks or descriptions');
  }
}
