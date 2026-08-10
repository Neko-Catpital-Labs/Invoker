import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';

import {
  autoFixRetryCapExternalKey,
  checkAutoFixRetryCap,
  recordAutoFixRetryConsumed,
} from '../auto-fix-retry-cap.js';
import type { WorkerDecisionStore } from '../worker-decision-ledger.js';

const now = '2026-01-01T00:00:00.000Z';

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  return {
    ...write,
    id: existing?.id ?? write.id,
    attemptCount: write.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeFakeStore() {
  const actions = new Map<string, WorkerActionRecord>();
  const store: WorkerDecisionStore = {
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
  };
  return { actions, store };
}

describe('checkAutoFixRetryCap', () => {
  it('allows a retry when nothing has been consumed yet', () => {
    const { store } = makeFakeStore();
    const decision = checkAutoFixRetryCap(store, 'task-1', 3);
    expect(decision).toEqual({ allowed: true, consumed: 0, budget: 3 });
  });

  it('allows a retry while consumed is under the budget', () => {
    const { store } = makeFakeStore();
    recordAutoFixRetryConsumed(store, 'task-1');
    const decision = checkAutoFixRetryCap(store, 'task-1', 3);
    expect(decision).toEqual({ allowed: true, consumed: 1, budget: 3 });
  });

  it('disallows a retry once consumed equals the budget', () => {
    const { store } = makeFakeStore();
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');
    const decision = checkAutoFixRetryCap(store, 'task-1', 3);
    expect(decision).toEqual({ allowed: false, consumed: 3, budget: 3 });
  });

  it('disallows a retry once consumed exceeds the budget', () => {
    const { store } = makeFakeStore();
    for (let i = 0; i < 5; i += 1) {
      recordAutoFixRetryConsumed(store, 'task-1');
    }
    const decision = checkAutoFixRetryCap(store, 'task-1', 3);
    expect(decision).toEqual({ allowed: false, consumed: 5, budget: 3 });
  });

  it('treats an unlimited budget as always allowed regardless of consumed count', () => {
    const { store } = makeFakeStore();
    for (let i = 0; i < 50; i += 1) {
      recordAutoFixRetryConsumed(store, 'task-1');
    }
    const decision = checkAutoFixRetryCap(store, 'task-1', Number.POSITIVE_INFINITY);
    expect(decision).toEqual({ allowed: true, consumed: 50, budget: Number.POSITIVE_INFINITY });
  });

  it('treats a zero or invalid budget as never allowed', () => {
    const { store } = makeFakeStore();
    expect(checkAutoFixRetryCap(store, 'task-1', 0)).toEqual({ allowed: false, consumed: 0, budget: 0 });
    expect(checkAutoFixRetryCap(store, 'task-1', 'not-a-number')).toEqual({ allowed: false, consumed: 0, budget: 0 });
  });

  it('keeps the retry count stable across generation bumps because the external key excludes generation', () => {
    const { store } = makeFakeStore();
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');

    const externalKey = autoFixRetryCapExternalKey('task-1');
    expect(externalKey).toBe('retry-cap:task-1');

    const decisionAfterHypotheticalGenerationBump = checkAutoFixRetryCap(store, 'task-1', 3);
    expect(decisionAfterHypotheticalGenerationBump).toEqual({ allowed: true, consumed: 2, budget: 3 });
  });

  it('keeps separate tasks on separate counters', () => {
    const { store } = makeFakeStore();
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');

    const decisionForOtherTask = checkAutoFixRetryCap(store, 'task-2', 3);
    expect(decisionForOtherTask).toEqual({ allowed: true, consumed: 0, budget: 3 });
  });
});

describe('recordAutoFixRetryConsumed', () => {
  it('increments the durable counter under the retry-cap external key', () => {
    const { store } = makeFakeStore();

    recordAutoFixRetryConsumed(store, 'task-1');

    expect(store.getWorkerAction).toHaveBeenCalledWith('autofix', 'retry-cap:task-1');
    const saved = store.getWorkerAction?.('autofix', 'retry-cap:task-1');
    expect(saved?.attemptCount).toBe(1);
  });

  it('calls upsertWorkerAction with incrementAttempt behavior producing attemptCount + 1 on each call', () => {
    const { store } = makeFakeStore();

    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');
    recordAutoFixRetryConsumed(store, 'task-1');

    expect(store.upsertWorkerAction).toHaveBeenCalledTimes(3);
    const saved = store.getWorkerAction?.('autofix', 'retry-cap:task-1');
    expect(saved?.attemptCount).toBe(3);
  });

  it('passes through optional workflowId and summary fields', () => {
    const { store } = makeFakeStore();

    recordAutoFixRetryConsumed(store, 'task-1', { workflowId: 'wf-1', summary: 'custom summary' });

    const saved = store.getWorkerAction?.('autofix', 'retry-cap:task-1');
    expect(saved?.workflowId).toBe('wf-1');
    expect(saved?.summary).toBe('custom summary');
  });
});
