import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteAdapter } from '../sqlite-adapter.js';

describe('pr_mirrors and pr_repair_leases', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('creates pr_mirrors and pr_repair_leases tables on fresh databases', () => {
    const tables = ((adapter as any).db.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pr_mirrors', 'pr_repair_leases') ORDER BY name`,
    ) as Array<{ values: unknown[][] }>)[0]?.values ?? [];
    expect(tables.map((row) => String(row[0]))).toEqual(['pr_mirrors', 'pr_repair_leases']);
  });

  it('upserts and reads pr mirrors', () => {
    const saved = adapter.upsertPrMirror({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'deadbeef',
      baseRef: 'main',
      mergeState: 'BLOCKED',
      labelsJson: '["stack"]',
      stackId: 'stack-1',
      stackOrder: 0,
      workflowId: 'wf-1',
      repairWorkflowsJson: '{"fix_ci":"wf-fix"}',
      blockersJson: '{"conflict":true}',
      updatedAt: '2026-07-25T17:00:00.000Z',
    });

    expect(saved.repo).toBe('owner/repo');
    expect(saved.prNumber).toBe(12);
    expect(saved.workflowId).toBe('wf-1');

    const updated = adapter.upsertPrMirror({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'cafebabe',
      updatedAt: '2026-07-25T18:00:00.000Z',
    });
    expect(updated.headSha).toBe('cafebabe');
    expect(updated.workflowId).toBeUndefined();
    expect(adapter.getPrMirror('owner/repo', 12)?.headSha).toBe('cafebabe');
  });

  it('supports pr repair lease CRUD keyed by repo/pr/head', () => {
    const lease = adapter.upsertPrRepairLease({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'deadbeef',
      holderKind: 'ci_failed',
      leaseId: 'lease-1',
      commandId: 'cmd-1',
      workflowId: 'wf-1',
      acquiredAt: '2026-07-25T17:00:00.000Z',
      expiresAt: '2026-07-25T17:30:00.000Z',
    });
    expect(lease.leaseId).toBe('lease-1');
    expect(adapter.getPrRepairLease('owner/repo', 12, 'deadbeef')?.holderKind).toBe('ci_failed');
    expect(adapter.getPrRepairLeaseById('lease-1')?.commandId).toBe('cmd-1');

    adapter.upsertPrRepairLease({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'deadbeef',
      holderKind: 'merge_conflict',
      leaseId: 'lease-2',
      acquiredAt: '2026-07-25T17:05:00.000Z',
    });
    expect(adapter.getPrRepairLeaseById('lease-1')).toBeUndefined();
    expect(adapter.getPrRepairLease('owner/repo', 12, 'deadbeef')?.leaseId).toBe('lease-2');

    expect(adapter.deletePrRepairLeaseById('lease-2')).toBe(true);
    expect(adapter.getPrRepairLease('owner/repo', 12, 'deadbeef')).toBeUndefined();
  });

  it('keeps distinct lease rows for different head shas', () => {
    adapter.upsertPrRepairLease({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'head-a',
      holderKind: 'ci_failed',
      leaseId: 'lease-a',
      acquiredAt: '2026-07-25T17:00:00.000Z',
    });
    adapter.upsertPrRepairLease({
      repo: 'owner/repo',
      prNumber: 12,
      headSha: 'head-b',
      holderKind: 'review_comments',
      leaseId: 'lease-b',
      acquiredAt: '2026-07-25T17:00:00.000Z',
    });

    expect(adapter.getPrRepairLease('owner/repo', 12, 'head-a')?.leaseId).toBe('lease-a');
    expect(adapter.getPrRepairLease('owner/repo', 12, 'head-b')?.leaseId).toBe('lease-b');
  });
});
