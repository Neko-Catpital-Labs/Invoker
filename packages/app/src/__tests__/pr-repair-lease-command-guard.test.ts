import { describe, expect, it } from 'vitest';

import { assertActiveBabysitPrRepairLease } from '../pr-repair-lease-command-guard.js';

const lease = {
  repo: 'owner/repo',
  prNumber: 123,
  headSha: 'sha-1',
  leaseId: 'lease-1',
};

describe('assertActiveBabysitPrRepairLease', () => {
  it('rejects a missing lease before a babysit mutation executes', () => {
    expect(() => assertActiveBabysitPrRepairLease(
      undefined,
      { getPrRepairLease: () => undefined, getPrRepairLeaseById: () => undefined },
      'repair',
    )).toThrow('Rejected babysit repair command');
  });

  it('rejects an expired or mismatched lease', () => {
    expect(() => assertActiveBabysitPrRepairLease(
      lease,
      {
        getPrRepairLease: () => undefined,
        getPrRepairLeaseById: () => ({
          ...lease,
          holderKind: 'ci_failed' as const,
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T00:00:01.000Z',
        }),
      },
      'repair',
    )).toThrow('Rejected babysit repair command');
  });

  it('accepts an active lease for the exact PR head', () => {
    expect(() => assertActiveBabysitPrRepairLease(
      lease,
      {
        getPrRepairLease: () => ({
          ...lease,
          holderKind: 'ci_failed' as const,
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
        getPrRepairLeaseById: () => ({
          ...lease,
          holderKind: 'ci_failed' as const,
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      },
      'repair',
    )).not.toThrow();
  });

  it('rejects a superseded lease id that no longer owns its PR head', () => {
    expect(() => assertActiveBabysitPrRepairLease(
      lease,
      {
        getPrRepairLease: () => ({
          ...lease,
          leaseId: 'lease-2',
          holderKind: 'merge_conflict' as const,
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
        getPrRepairLeaseById: () => ({
          ...lease,
          holderKind: 'ci_failed' as const,
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      },
      'repair',
    )).toThrow('Rejected babysit repair command');
  });
});
