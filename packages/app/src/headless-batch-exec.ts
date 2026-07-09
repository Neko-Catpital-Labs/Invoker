import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';

export interface HeadlessExecMutationPayload {
  args: string[];
  waitForApproval?: boolean;
  noTrack?: boolean;
  traceId?: string;
}

export interface HeadlessBatchExecItem {
  label?: string;
  workflowId?: string;
  args?: unknown;
}

export interface HeadlessBatchExecRequest {
  items?: unknown;
  waitForApproval?: boolean;
  noTrack?: boolean;
  traceId?: string;
}

export interface HeadlessBatchExecResult {
  label?: string;
  workflowId?: string;
  args: string[];
  ok: boolean;
  response?: { ok: true; intentId: number };
  error?: string;
}

export type HeadlessExecClassification = {
  workflowId?: string;
  priority: WorkflowMutationPriority;
};

export type HeadlessBatchExecDeps = {
  classify: (payload: HeadlessExecMutationPayload) => HeadlessExecClassification;
  submit: (
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: 'headless.exec',
    args: [HeadlessExecMutationPayload],
    options: { deferDrain: true },
  ) => number;
};

function resultBase(item: HeadlessBatchExecItem): Pick<HeadlessBatchExecResult, 'label' | 'workflowId' | 'args'> {
  return {
    label: typeof item.label === 'string' ? item.label : undefined,
    workflowId: typeof item.workflowId === 'string' ? item.workflowId : undefined,
    args: Array.isArray(item.args) && item.args.every((arg) => typeof arg === 'string') ? item.args : [],
  };
}

function isRetryableQueueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

export function executeNoTrackHeadlessBatch(
  request: HeadlessBatchExecRequest,
  deps: HeadlessBatchExecDeps,
): HeadlessBatchExecResult[] {
  if (!request.noTrack) {
    throw new Error('headless.batch-exec only supports noTrack=true');
  }
  if (!Array.isArray(request.items)) {
    throw new Error('headless.batch-exec requires an items array');
  }

  return request.items.map((rawItem): HeadlessBatchExecResult => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as HeadlessBatchExecItem : {};
    const base = resultBase(item);
    try {
      if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === 'string')) {
        throw new Error('Invalid batch item: args must be a string array');
      }
      if (item.args.length === 0) {
        throw new Error('Invalid batch item: args must not be empty');
      }

      const payload: HeadlessExecMutationPayload = {
        args: item.args,
        waitForApproval: request.waitForApproval,
        noTrack: true,
        traceId: request.traceId,
      };
      const { workflowId, priority } = deps.classify(payload);
      if (!workflowId) {
        throw new Error('Fire-and-forget headless.exec could not be queued: workflow-not-resolved');
      }
      const intentId = deps.submit(workflowId, priority, 'headless.exec', [payload], { deferDrain: true });
      return {
        ...base,
        workflowId,
        ok: true,
        response: { ok: true, intentId },
      };
    } catch (error) {
      if (isRetryableQueueError(error)) {
        throw error;
      }
      return {
        ...base,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
