import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

describe('repair_filings ledger', () => {
  it('rejects a second insert for the identical (kind, subject, stateSha) key', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const first = adapter.insertRepairFiling({
        kind: 'ci-regression:required-fast-guardrails',
        subject: 'master',
        stateSha: 'sha-a',
      });
      expect(first.inserted).toBe(true);

      // Same process, same connection, identical key -- this is the case a
      // naive "read the file, decide, then append" implementation would get
      // right too; the real proof is the cross-process case below.
      const second = adapter.insertRepairFiling({
        kind: 'ci-regression:required-fast-guardrails',
        subject: 'master',
        stateSha: 'sha-a',
      });
      expect(second.inserted).toBe(false);
      expect(second.row.id).toBe(first.row.id);

      const rows = adapter.listRepairFilings('ci-regression:required-fast-guardrails', 'master');
      expect(rows).toHaveLength(1);
    } finally {
      adapter.close();
    }
  });

  it('rejects a duplicate filed by a fresh adapter instance against the same on-disk DB (simulated second process)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-filings-'));
    const dbPath = join(dir, 'invoker.db');
    try {
      const callerA = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      const filedByA = callerA.insertRepairFiling({
        kind: 'admin-requeue:rebase-conflict',
        subject: '9425',
        stateSha: 'sha-b',
      });
      expect(filedByA.inserted).toBe(true);
      callerA.close();

      // A brand new adapter instance opened fresh against the same file --
      // no in-memory state carried over from callerA -- stands in for a
      // second, independent OS process (e.g. a second cron sweep) racing
      // to file the same repair.
      const callerB = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      const filedByB = callerB.insertRepairFiling({
        kind: 'admin-requeue:rebase-conflict',
        subject: '9425',
        stateSha: 'sha-b',
      });
      expect(filedByB.inserted).toBe(false);
      expect(filedByB.row.id).toBe(filedByA.row.id);

      const rows = callerB.listRepairFilings('admin-requeue:rebase-conflict', '9425');
      expect(rows).toHaveLength(1);
      callerB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not suppress a genuinely new state: different kind or different stateSha both file as new work', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      // Worked example from the design: rebase-conflict repaired at shaA,
      // then a *different* check (ui-vitest) fails at shaB on the same PR,
      // then master moves and the PR needs rebasing again, still at shaB.
      const rebaseAtShaA = adapter.insertRepairFiling({
        kind: 'admin-requeue:rebase-conflict',
        subject: '9425',
        stateSha: 'sha-a',
      });
      expect(rebaseAtShaA.inserted).toBe(true);

      const uiVitestAtShaB = adapter.insertRepairFiling({
        kind: 'admin-requeue:check:ui-vitest',
        subject: '9425',
        stateSha: 'sha-b',
      });
      expect(uiVitestAtShaB.inserted).toBe(true);

      const rebaseAtShaBAgain = adapter.insertRepairFiling({
        kind: 'admin-requeue:rebase-conflict',
        subject: '9425',
        stateSha: 'sha-b',
      });
      expect(rebaseAtShaBAgain.inserted).toBe(true);

      // But re-detecting the same problem on the same state still collapses to one row.
      const rebaseAtShaBRepeat = adapter.insertRepairFiling({
        kind: 'admin-requeue:rebase-conflict',
        subject: '9425',
        stateSha: 'sha-b',
      });
      expect(rebaseAtShaBRepeat.inserted).toBe(false);

      const rows = adapter.listRepairFilings('admin-requeue:rebase-conflict', '9425');
      expect(rows).toHaveLength(2); // shaA and shaB, not a third for the repeat
    } finally {
      adapter.close();
    }
  });

  it('release deletes a claimed row so a later attempt can reclaim the same key', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const claimed = adapter.insertRepairFiling({
        kind: 'ci-regression:required-fast-guardrails',
        subject: 'master',
        stateSha: 'sha-d',
      });
      expect(claimed.inserted).toBe(true);

      const released = adapter.deleteRepairFiling('ci-regression:required-fast-guardrails', 'master', 'sha-d');
      expect(released).toBe(true);
      expect(adapter.getRepairFiling('ci-regression:required-fast-guardrails', 'master', 'sha-d')).toBeUndefined();

      // Reclaiming after release must succeed -- a transient downstream
      // filing failure must not permanently block all future retries for
      // this (kind, subject, stateSha).
      const reclaimed = adapter.insertRepairFiling({
        kind: 'ci-regression:required-fast-guardrails',
        subject: 'master',
        stateSha: 'sha-d',
      });
      expect(reclaimed.inserted).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it('release on a key that was never claimed is a no-op that returns false', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const released = adapter.deleteRepairFiling('ci-regression:required-fast-guardrails', 'master', 'sha-never-claimed');
      expect(released).toBe(false);
    } finally {
      adapter.close();
    }
  });

  it('stamps created_at from the DB clock, not a caller-supplied value', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const result = adapter.insertRepairFiling({
        kind: 'ci-regression:fleet',
        subject: 'master',
        stateSha: 'sha-c',
        metadata: { memberJobs: ['a', 'b', 'c'] },
      });
      expect(result.row.createdAt).toBeTruthy();
      expect(result.row.metadata).toEqual({ memberJobs: ['a', 'b', 'c'] });

      const fetched = adapter.getRepairFiling('ci-regression:fleet', 'master', 'sha-c');
      expect(fetched?.createdAt).toBe(result.row.createdAt);
    } finally {
      adapter.close();
    }
  });
});
