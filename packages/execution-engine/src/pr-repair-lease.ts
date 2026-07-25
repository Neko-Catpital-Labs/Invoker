import { randomUUID } from 'node:crypto';

import type { PrRepairHolderKind, PrRepairLeaseRow } from '@invoker/data-store';

export type RepairKind = PrRepairHolderKind;

export const REPAIR_KIND_RANK: Readonly<Record<RepairKind, number>> = {
  merge_conflict: 0,
  ci_failed: 1,
  review_comments: 2,
  queue_dequeued: 3,
};

export const PR_REPAIR_LEASE_DEFAULT_MS = 30 * 60 * 1000;

export interface PrRepairLeaseStore {
  getPrRepairLease(repo: string, prNumber: number, headSha: string): PrRepairLeaseRow | undefined;
  upsertPrRepairLease(lease: PrRepairLeaseRow): PrRepairLeaseRow;
  getPrRepairLeaseById(leaseId: string): PrRepairLeaseRow | undefined;
  deletePrRepairLeaseById(leaseId: string): boolean;
}

export interface PrRepairLeaseContext {
  repo: string;
  prNumber: number;
  headSha: string;
  leaseId: string;
}

export type TryAcquirePrRepairLeaseResult =
  | { ok: true; leaseId: string; preempted: false }
  | { ok: true; leaseId: string; preempted: true; previousHolderKind: RepairKind }
  | { ok: false; holderKind: RepairKind; reason: 'held_by_higher_or_equal_priority' };

export interface TryAcquirePrRepairLeaseInput {
  repo: string;
  prNumber: number;
  headSha: string;
  kind: RepairKind;
  store: PrRepairLeaseStore;
  now?: Date;
  leaseMs?: number;
  commandId?: string;
  workflowId?: string;
  createLeaseId?: () => string;
}

function isLeaseActive(lease: PrRepairLeaseRow, nowIso: string): boolean {
  if (lease.expiresAt == null) return true;
  return lease.expiresAt > nowIso;
}

export function resolveReviewGatePrRepairIdentity(
  reviewUrl: string,
  reviewId: string,
): Omit<PrRepairLeaseContext, 'headSha' | 'leaseId'> | undefined {
  const fromUrl = reviewUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (fromUrl?.[1] && fromUrl[2]) {
    return { repo: fromUrl[1], prNumber: Number(fromUrl[2]) };
  }
  const fromId = reviewId.match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  if (fromId?.[1] && fromId[2]) {
    return { repo: fromId[1], prNumber: Number(fromId[2]) };
  }
  return undefined;
}

export function hasActivePrRepairLease(
  context: PrRepairLeaseContext | undefined,
  store: Pick<PrRepairLeaseStore, 'getPrRepairLease' | 'getPrRepairLeaseById'>,
  now: Date = new Date(),
): boolean {
  if (!context) return false;
  const lease = store.getPrRepairLeaseById(context.leaseId);
  const headLease = store.getPrRepairLease(context.repo, context.prNumber, context.headSha);
  return Boolean(
    lease
    && headLease?.leaseId === context.leaseId
    && lease.repo === context.repo
    && lease.prNumber === context.prNumber
    && lease.headSha === context.headSha
    && isLeaseActive(lease, now.toISOString()),
  );
}

export function tryAcquirePrRepairLease(
  input: TryAcquirePrRepairLeaseInput,
): TryAcquirePrRepairLeaseResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseMs = input.leaseMs ?? PR_REPAIR_LEASE_DEFAULT_MS;
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const existing = input.store.getPrRepairLease(input.repo, input.prNumber, input.headSha);

  if (existing && isLeaseActive(existing, nowIso)) {
    const holderRank = REPAIR_KIND_RANK[existing.holderKind];
    const requesterRank = REPAIR_KIND_RANK[input.kind];
    if (requesterRank >= holderRank) {
      return {
        ok: false,
        holderKind: existing.holderKind,
        reason: 'held_by_higher_or_equal_priority',
      };
    }

    const leaseId = (input.createLeaseId ?? randomUUID)();
    input.store.upsertPrRepairLease({
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      holderKind: input.kind,
      leaseId,
      commandId: input.commandId,
      workflowId: input.workflowId,
      acquiredAt: nowIso,
      expiresAt,
    });
    return {
      ok: true,
      leaseId,
      preempted: true,
      previousHolderKind: existing.holderKind,
    };
  }

  const leaseId = (input.createLeaseId ?? randomUUID)();
  input.store.upsertPrRepairLease({
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    holderKind: input.kind,
    leaseId,
    commandId: input.commandId,
    workflowId: input.workflowId,
    acquiredAt: nowIso,
    expiresAt,
  });
  return { ok: true, leaseId, preempted: false };
}

export function releasePrRepairLease(leaseId: string, store: PrRepairLeaseStore): boolean {
  return store.deletePrRepairLeaseById(leaseId);
}

export function getPrRepairLease(
  repo: string,
  prNumber: number,
  headSha: string,
  store: PrRepairLeaseStore,
): PrRepairLeaseRow | undefined {
  return store.getPrRepairLease(repo, prNumber, headSha);
}
