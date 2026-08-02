import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reclaimAdminWorkDirs,
  reclaimDeletingOrphans,
  pruneHourlySnapshotsForReaper,
  trimInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  return root;
}

function touchOld(path: string, nowMs: number, ageMs: number): void {
  const date = new Date(nowMs - ageMs);
  utimesSync(path, date, date);
}

function seedHourly(backupDir: string, count: number): void {
  mkdirSync(backupDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(backupDir, `invoker.db.hourly-auto-20260101-${String(i).padStart(6, '0')}-000Z`),
      `snapshot-${i}`,
    );
  }
}

function hourlySnapshots(backupDir: string): string[] {
  return readdirSync(backupDir)
    .filter((name) => name.startsWith('invoker.db.hourly-auto-'))
    .sort();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reclaimDeletingOrphans', () => {
  it('removes dot-deleting entries older than thirty minutes and checks remotes', async () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    mkdirSync(join(home, 'merge-clones.deleting.old'), { recursive: true });
    writeFileSync(join(home, 'merge-clones.deleting.old', 'file.txt'), 'old');
    mkdirSync(join(home, 'worktrees'), { recursive: true });
    writeFileSync(join(home, 'worktrees', 'kept.txt'), 'keep');
    touchOld(join(home, 'merge-clones.deleting.old'), nowMs, 31 * 60 * 1000);

    const remoteTarget: RemoteDiskTarget = {
      name: 'remote-1',
      connection: { host: 'example.invalid', user: 'invoker', sshKeyPath: '/tmp/key' },
      remotePath: '~/.invoker',
    };
    const runRemoteScript = vi.fn(async () => '__INVOKER_REAPER_REMOVED__=2\n');

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets: [remoteTarget],
      runRemoteScript,
    });

    expect(existsSync(join(home, 'merge-clones.deleting.old'))).toBe(false);
    expect(existsSync(join(home, 'worktrees', 'kept.txt'))).toBe(true);
    expect(results.find((r) => r.targetKey.startsWith('local'))?.removed).toBe(1);
    expect(results.find((r) => r.targetKey.startsWith('ssh:'))?.removed).toBe(2);
    expect(runRemoteScript).toHaveBeenCalledWith(
      remoteTarget,
      expect.stringContaining("-name '*.deleting.*' -mmin +30"),
    );
  });

  it('leaves recent dot-deleting entries alone', async () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    mkdirSync(join(home, 'merge-clones.deleting.recent'), { recursive: true });
    writeFileSync(join(home, 'merge-clones.deleting.recent', 'file.txt'), 'recent');
    touchOld(join(home, 'merge-clones.deleting.recent'), nowMs, 5 * 60 * 1000);

    const results = await reclaimDeletingOrphans({ invokerHome: home, userHome: root, nowMs });

    expect(results[0]?.removed).toBe(0);
    expect(existsSync(join(home, 'merge-clones.deleting.recent'))).toBe(true);
  });
});

describe('reclaimAdminWorkDirs', () => {
  it('removes immediate admin-work children older than forty-eight hours', () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const oldChild = join(home, 'mergify-admin-requeue-work', 'old-checkout');
    const nestedOld = join(home, 'land-admin-bypass-work', 'recent-parent', 'old-nested');
    mkdirSync(oldChild, { recursive: true });
    mkdirSync(nestedOld, { recursive: true });
    writeFileSync(join(oldChild, 'file.txt'), 'old');
    touchOld(oldChild, nowMs, 49 * 60 * 60 * 1000);
    touchOld(nestedOld, nowMs, 49 * 60 * 60 * 1000);

    const result = reclaimAdminWorkDirs({ invokerHome: home, userHome: root, nowMs });

    expect(result.removed).toBe(1);
    expect(existsSync(oldChild)).toBe(false);
    expect(existsSync(join(home, 'mergify-admin-requeue-work'))).toBe(true);
    expect(existsSync(join(home, 'land-admin-bypass-work'))).toBe(true);
    expect(existsSync(nestedOld)).toBe(true);
  });

  it('leaves recent admin-work children alone', () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const recentChild = join(home, 'land-admin-bypass-work', 'recent-checkout');
    mkdirSync(recentChild, { recursive: true });
    touchOld(recentChild, nowMs, 2 * 60 * 60 * 1000);

    const result = reclaimAdminWorkDirs({ invokerHome: home, userHome: root, nowMs });

    expect(result.removed).toBe(0);
    expect(existsSync(recentChild)).toBe(true);
  });
});

describe('pruneHourlySnapshotsForReaper', () => {
  it('uses the existing hourly retention resolver and prune function', () => {
    const root = makeRoot();
    const backupDir = join(root, 'db-backups');
    seedHourly(backupDir, 4);
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'keep');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = pruneHourlySnapshotsForReaper(root);

    expect(result.removed).toBe(2);
    expect(hourlySnapshots(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone while they are within retention', () => {
    const root = makeRoot();
    const backupDir = join(root, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = pruneHourlySnapshotsForReaper(root);

    expect(result.removed).toBe(0);
    expect(hourlySnapshots(backupDir)).toHaveLength(2);
  });
});

describe('trimInvokerLogs', () => {
  it('keeps only the tail of known log files once they exceed the size limit', () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'invoker.log'), '0123456789abcdef');
    writeFileSync(join(home, 'ui-task-graph-events.jsonl'), 'abcdefghijklmnop');
    writeFileSync(join(home, 'other.log'), '0123456789abcdef');

    const result = trimInvokerLogs({
      invokerHome: home,
      userHome: root,
      trimThresholdBytes: 10,
      retainBytes: 6,
    });

    expect(result.trimmed).toBe(2);
    expect(readFileSync(join(home, 'invoker.log'), 'utf8')).toBe('abcdef');
    expect(readFileSync(join(home, 'ui-task-graph-events.jsonl'), 'utf8')).toBe('klmnop');
    expect(readFileSync(join(home, 'other.log'), 'utf8')).toBe('0123456789abcdef');
  });

  it('leaves known log files alone while they are under the size limit', () => {
    const root = makeRoot();
    const home = join(root, '.invoker');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'gui.log'), 'small');

    const before = statSync(join(home, 'gui.log')).size;
    const result = trimInvokerLogs({
      invokerHome: home,
      userHome: root,
      trimThresholdBytes: 10,
      retainBytes: 6,
    });

    expect(result.trimmed).toBe(0);
    expect(statSync(join(home, 'gui.log')).size).toBe(before);
    expect(readFileSync(join(home, 'gui.log'), 'utf8')).toBe('small');
  });
});
