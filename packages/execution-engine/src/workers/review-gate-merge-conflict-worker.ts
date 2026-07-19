import type {
  WorkerActionRecord,
  WorkerActionWrite,
} from '../worker-decision-ledger.js';
import type {
  ReviewGateMergeConflictLifecycleEvent,
} from '../lifecycle-events.js';

export const REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND = 'review-gate-merge-conflict';
export const DEFAULT_REVIEW_GATE_MERGE_CONFLICT_WORKER_INTERVAL_MS = 60_000;

export interface ReviewGateMergeConflictWorkerStore {
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ReviewGateMergeConflictWorkerSubmitter {
  submit(
    workflowId: string,
    priority: 'high' | 'normal',
    channel: 'invoker:rebase-recreate',
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

const NO_HEAD_SHA = 'no-head';

export function reviewGateMergeConflictActionKey(event: Pick<
  ReviewGateMergeConflictLifecycleEvent,
  'taskId' | 'reviewId' | 'headSha'
>): string {
  return [
    'review-gate-merge-conflict',
    event.taskId,
    event.reviewId,
    event.headSha ?? NO_HEAD_SHA,
  ].join(':');
}
