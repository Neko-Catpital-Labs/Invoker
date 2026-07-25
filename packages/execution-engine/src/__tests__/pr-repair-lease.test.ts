import { describe, expect, it } from 'vitest';

import type { PrRepairLeaseRow } from '@invoker/data-store';

import {
  getPrRepairLease,
  releasePrRepairLease,
  REPAIR_KIND_RANK,
  tryAcquirePrRepairLease,
  type PrRepairLeaseStore,
  type RepairKind,
} from '../pr-repair-lease.js';

function createMemoryStore(): PrRepairLeaseStore {
  const byKey = new Map<string, PrRepairLeaseRow>();
  const byId = new Map<string, PrRepairLeaseRow>();
  const keyOf = (repo: string, prNumber: number, headSha: string) =>
    `${repo}\0${prNumber}\0${headSha}`;

  return {
    getPrRepairLease(repo, prNumber, headSha) {
      return byKey.get(keyOf(repo, prNumber, headSha));
    },
    upsertPrRepairLease(lease) {
      const prev = byKey.get(keyOf(lease.repo, lease.prNumber, lease.headSha));
      if (prev) byId.delete(prev.leaseId);
      byKey.set(keyOf(lease.repo, lease.prNumber, lease.headSha), lease);
      byId.set(lease.leaseId, lease);
      return lease;
    },
    getPrRepairLeaseById(leaseId) {
      return byId.get(leaseId);
    },
    deletePrRepairLeaseById(leaseId) {
      const existing = byId.get(leaseId);
      if (!existing) return false;
      byId.delete(leaseId);
      byKey.delete(keyOf(existing.repo, existing.prNumber, existing.headSha));
      return true;
    },
  };
}

describe('REPAIR_KIND_RANK', () => {
  it('orders conflict above ci above review above queue', () => {
    expect(REPAIR_KIND_RANK.merge_conflict).toBeLessThan(REPAIR_KIND_RANK.ci_failed);
    expect(REPAIR_KIND_RANK.ci_failed).toBeLessThan(REPAIR_KIND_RANK.review_comments);
    expect(REPAIR_KIND_RANK.review_comments).toBeLessThan(REPAIR_KIND_RANK.queue_dequeued);
  });
});

describe('tryAcquirePrRepairLease', () => {
  const repo = 'owner/repo';
  const prNumber = 42;
  const headSha = 'abc123';
  const now = new Date('2026-07-25T17:00:00.000Z');

  function acquire(store: PrRepairLeaseStore, kind: RepairKind, leaseId: string) {
    return tryAcquirePrRepairLease({
      repo,
      prNumber,
      headSha,
      kind,
      store,
      now,
      createLeaseId: () => leaseId,
    });
  }

  it('grants when empty', () => {
    const store = createMemoryStore();
    const result = acquire(store, 'ci_failed', 'lease-ci-1');
    expect(result).toEqual({ ok: true, leaseId: 'lease-ci-1', preempted: false });
    expect(getPrRepairLease(repo, prNumber, headSha, store)?.holderKind).toBe('ci_failed');
  });

  it('lets conflict beat ci', () => {
    const store = createMemoryStore();
    expect(acquire(store, 'ci_failed', 'lease-ci').ok).toBe(true);

    const conflict = acquire(store, 'merge_conflict', 'lease-conflict');
    expect(conflict).toEqual({
      ok: true,
      leaseId: 'lease-conflict',
      preempted: true,
      previousHolderKind: 'ci_failed',
    });
    expect(getPrRepairLease(repo, prNumber, headSha, store)?.leaseId).toBe('lease-conflict');
  });

  it('denies ci while conflict holds', () => {
    const store = createMemoryStore();
    expect(acquire(store, 'merge_conflict', 'lease-conflict').ok).toBe(true);

    const denied = acquire(store, 'ci_failed', 'lease-ci');
    expect(denied).toEqual({
      ok: false,
      holderKind: 'merge_conflict',
      reason: 'held_by_higher_or_equal_priority',
    });
  });

  it('allows ci after conflict releases', () => {
    const store = createMemoryStore();
    const conflict = acquire(store, 'merge_conflict', 'lease-conflict');
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) throw new Error('expected grant');

    expect(releasePrRepairLease(conflict.leaseId, store)).toBe(true);
    expect(getPrRepairLease(repo, prNumber, headSha, store)).toBeUndefined();

    const ci = acquire(store, 'ci_failed', 'lease-ci');
    expect(ci).toEqual({ ok: true, leaseId: 'lease-ci', preempted: false });
  });

  it('preempts from review to conflict', () => {
    const store = createMemoryStore();
    expect(acquire(store, 'review_comments', 'lease-review').ok).toBe(true);

    const conflict = acquire(store, 'merge_conflict', 'lease-conflict');
    expect(conflict).toEqual({
      ok: true,
      leaseId: 'lease-conflict',
      preempted: true,
      previousHolderKind: 'review_comments',
    });
  });

  it('denies equal priority re-acquire', () => {
    const store = createMemoryStore();
    expect(acquire(store, 'ci_failed', 'lease-ci-1').ok).toBe(true);
    expect(acquire(store, 'ci_failed', 'lease-ci-2')).toEqual({
      ok: false,
      holderKind: 'ci_failed',
      reason: 'held_by_higher_or_equal_priority',
    });
  });

  it('treats different headSha as a separate lease row', () => {
    const store = createMemoryStore();
    expect(
      tryAcquirePrRepairLease({
        repo,
        prNumber,
        headSha: 'head-a',
        kind: 'ci_failed',
        store,
        now,
        createLeaseId: () => 'lease-a',
      }).ok,
    ).toBe(true);

    const otherHead = tryAcquirePrRepairLease({
      repo,
      prNumber,
      headSha: 'head-b',
      kind: 'review_comments',
      store,
      now,
      createLeaseId: () => 'lease-b',
    });
    expect(otherHead).toEqual({ ok: true, leaseId: 'lease-b', preempted: false });
    expect(getPrRepairLease(repo, prNumber, 'head-a', store)?.leaseId).toBe('lease-a');
    expect(getPrRepairLease(repo, prNumber, 'head-b', store)?.leaseId).toBe('lease-b');
  });

  it('treats expired leases as empty', () => {
    const store = createMemoryStore();
    const past = new Date('2026-07-25T16:00:00.000Z');
    expect(
      tryAcquirePrRepairLease({
        repo,
        prNumber,
        headSha,
        kind: 'review_comments',
        store,
        now: past,
        leaseMs: 1,
        createLeaseId: () => 'lease-expired',
      }).ok,
    ).toBe(true);

    const next = tryAcquirePrRepairLease({
      repo,
      prNumber,
      headSha,
      kind: 'ci_failed',
      store,
      now,
      createLeaseId: () => 'lease-fresh',
    });
    expect(next).toEqual({ ok: true, leaseId: 'lease-fresh', preempted: false });
  });
});
