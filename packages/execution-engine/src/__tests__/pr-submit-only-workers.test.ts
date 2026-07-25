import { describe, expect, it, vi } from 'vitest';

import type { PrRepairLeaseRow, WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';

import type {
  PrQueueDequeuedLifecycleEvent,
  PrReviewCommentsLifecycleEvent,
} from '../lifecycle-events.js';
import {
  createPrQueueLandTick,
  PR_QUEUE_LAND_WORKER_KIND,
  prQueueLandActionKey,
} from '../workers/pr-queue-land-worker.js';
import {
  createReviewCommentsTick,
  REVIEW_COMMENTS_WORKER_KIND,
  reviewCommentsActionKey,
} from '../workers/review-comments-worker.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

function createStore() {
  const actions = new Map<string, WorkerActionRecord>();
  const leases = new Map<string, PrRepairLeaseRow>();
  return {
    actions,
    leases,
    store: {
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const now = '2026-01-01T00:00:00.000Z';
        const record: WorkerActionRecord = {
          ...write,
          attemptCount: write.attemptCount ?? 0,
          createdAt: now,
          updatedAt: now,
        };
        actions.set(`${write.workerKind}:${write.externalKey}`, record);
        return record;
      }),
      getPrRepairLease: vi.fn((repo: string, prNumber: number, headSha: string) => leases.get(`${repo}:${prNumber}:${headSha}`)),
      upsertPrRepairLease: vi.fn((lease: PrRepairLeaseRow) => {
        leases.set(`${lease.repo}:${lease.prNumber}:${lease.headSha}`, lease);
        return lease;
      }),
      getPrRepairLeaseById: vi.fn((leaseId: string) => Array.from(leases.values()).find((lease) => lease.leaseId === leaseId)),
      deletePrRepairLeaseById: vi.fn((leaseId: string) => {
        const entry = Array.from(leases.entries()).find(([, lease]) => lease.leaseId === leaseId);
        if (!entry) return false;
        leases.delete(entry[0]);
        return true;
      }),
    },
  };
}

const reviewEvent: PrReviewCommentsLifecycleEvent = {
  eventKey: 'review-1',
  kind: 'pr.review_comments',
  repo: 'owner/repo',
  prNumber: 12,
  headSha: 'abc',
  commentMarker: 'comment-1',
  commentUrls: ['https://github.com/owner/repo/pull/12#discussion_r1'],
  workflowId: 'wf-1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const queueEvent: PrQueueDequeuedLifecycleEvent = {
  eventKey: 'queue-1',
  kind: 'pr.queue_dequeued',
  repo: 'owner/repo',
  prNumber: 12,
  headSha: 'abc',
  dequeueCommentId: '900',
  failedChecks: ['CI'],
  createdAt: '2026-01-01T00:00:00.000Z',
};
const unmappedReviewEvent: PrReviewCommentsLifecycleEvent = {
  ...reviewEvent,
  workflowId: undefined,
};

const unmappedQueueEvent: PrQueueDequeuedLifecycleEvent = {
  ...queueEvent,
  workflowId: undefined,
};


describe('submit-only PR lifecycle workers', () => {
  it('deduplicates review comments, records command-not-ready, and releases its lease', async () => {
    const harness = createStore();
    const tick = createReviewCommentsTick({ store: harness.store, logger, drainEvents: () => [reviewEvent, reviewEvent] });

    await tick({ identity: { kind: REVIEW_COMMENTS_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.store.upsertPrRepairLease).toHaveBeenCalledWith(expect.objectContaining({ holderKind: 'review_comments' }));
    expect(harness.actions.get(`${REVIEW_COMMENTS_WORKER_KIND}:${reviewCommentsActionKey(reviewEvent)}`)).toMatchObject({
      status: 'skipped',
      workflowId: 'wf-1',
      payload: expect.objectContaining({ reason: 'command-not-ready' }),
    });
    expect(harness.leases).toEqual(new Map());
  });

  it('records workflow-unmapped for review comments and releases the lease', async () => {
    const harness = createStore();
    const tick = createReviewCommentsTick({ store: harness.store, logger, drainEvents: () => [unmappedReviewEvent] });

    await tick({ identity: { kind: REVIEW_COMMENTS_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.actions.get(`${REVIEW_COMMENTS_WORKER_KIND}:${reviewCommentsActionKey(unmappedReviewEvent)}`)).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'workflow-unmapped', commentUrls: reviewEvent.commentUrls }),
    });
    expect(harness.leases).toEqual(new Map());
  });

  it('records workflow-unmapped queue action without falling back to command-not-ready', async () => {
    const harness = createStore();
    const tick = createPrQueueLandTick({ store: harness.store, logger, drainEvents: () => [unmappedQueueEvent] });

    await tick({ identity: { kind: PR_QUEUE_LAND_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(harness.store.upsertPrRepairLease).toHaveBeenCalledWith(expect.objectContaining({ holderKind: 'queue_dequeued' }));
    const action = harness.actions.get(`${PR_QUEUE_LAND_WORKER_KIND}:${prQueueLandActionKey(unmappedQueueEvent)}`);
    expect(action).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'workflow-unmapped', failedChecks: ['CI'] }),
    });
    expect(action?.workflowId).toBeUndefined();
    expect(harness.leases).toEqual(new Map());
  });

  it('records command-not-ready for mapped dequeue repairs', async () => {
    const harness = createStore();
    const tick = createPrQueueLandTick({
      store: harness.store,
      logger,
      drainEvents: () => [{ ...queueEvent, workflowId: 'wf-1' }],
    });

    await tick({ identity: { kind: PR_QUEUE_LAND_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    const action = harness.actions.get(`${PR_QUEUE_LAND_WORKER_KIND}:${prQueueLandActionKey({ ...queueEvent, workflowId: 'wf-1' })}`);
    expect(action).toMatchObject({
      status: 'skipped',
      workflowId: 'wf-1',
      payload: expect.objectContaining({ reason: 'command-not-ready', failedChecks: ['CI'] }),
    });
    expect(harness.leases).toEqual(new Map());
  });
  it('records cooldown-active instead of resubmitting the same dequeue fingerprint', async () => {
    const harness = createStore();
    const externalKey = prQueueLandActionKey({ ...queueEvent, workflowId: 'wf-1' });
    const now = new Date().toISOString();
    harness.actions.set(`${PR_QUEUE_LAND_WORKER_KIND}:${externalKey}`, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: 'land-dequeued-pr',
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${queueEvent.repo}#${queueEvent.prNumber}`,
      workflowId: 'wf-1',
      status: 'failed',
      summary: 'Older dequeue repair failed',
      payload: { headSha: queueEvent.headSha, failedChecks: queueEvent.failedChecks },
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    const tick = createPrQueueLandTick({
      store: harness.store,
      logger,
      drainEvents: () => [{ ...queueEvent, workflowId: 'wf-1' }],
    });

    await tick({ identity: { kind: PR_QUEUE_LAND_WORKER_KIND, instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    const action = harness.actions.get(`${PR_QUEUE_LAND_WORKER_KIND}:${externalKey}`);
    expect(action).toMatchObject({
      status: 'skipped',
      workflowId: 'wf-1',
      payload: expect.objectContaining({ reason: 'cooldown-active', failedChecks: ['CI'] }),
    });
    expect((action?.payload as Record<string, unknown>).cooldownUntil).toEqual(expect.any(String));
    expect(harness.leases).toEqual(new Map());
  });

});
