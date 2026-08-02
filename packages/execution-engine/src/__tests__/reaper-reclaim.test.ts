import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  AUTOMATION_WORK_DIRS,
  AUTOMATION_WORK_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshots,
  trimInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, nowMs: number, ageMs: number): void {
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

function hourlyBaseNames(backupDir: string): string[] {
  return readdirSync(backupDir).filter(
    (name) =>
      name.startsWith('invoker.db.hourly-auto-') &&
      !name.endsWith('-wal') &&
      !name.endsWith('-shm'),
  );
}

describe('reclaimDeletingOrphans', () => {
  it('removes only dot-deleting entries older than 30 minutes locally and uses the narrow remote sweep', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-08-02T00:00:00.000Z');

    const oldOrphan = join(home, 'merge-clones.deleting.123');
    mkdirSync(join(oldOrphan, 'stale'), { recursive: true });
    writeFileSync(join(oldOrphan, 'stale', 'file.txt'), 'remove');
    setAge(oldOrphan, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const recentOrphan = join(home, 'repos.deleting.456');
    mkdirSync(recentOrphan, { recursive: true });
    setAge(recentOrphan, nowMs, DELETING_ORPHAN_MIN_AGE_MS - 60_000);

    const nonMatchingOld = join(home, 'worktrees-old');
    mkdirSync(nonMatchingOld, { recursive: true });
    setAge(nonMatchingOld, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'remote-1',
      connection: { host: 'remote.example', user: 'invoker', sshKeyPath: '/tmp/key' },
      remotePath: '~/.invoker',
    }];
    const runRemoteScript = vi.fn(async () => 'remote removed=1');

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets,
      runRemoteScript,
    });

    expect(results[0]).toMatchObject({ ok: true, reason: 'deleting-orphans', removed: 1 });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(nonMatchingOld)).toBe(true);

    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain("-name '*.deleting.*'");
    expect(script).toContain('-mmin +30');
    expect(script).not.toContain('pr-cron-work');
    expect(script).not.toContain('remove_path');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes only immediate children older than 48 hours and leaves the work roots plus recent children', () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-08-02T00:00:00.000Z');
    const [mergifyRootName, landRootName] = AUTOMATION_WORK_DIRS;
    const mergifyRoot = join(home, mergifyRootName);
    const landRoot = join(home, landRootName);
    mkdirSync(mergifyRoot, { recursive: true });
    mkdirSync(landRoot, { recursive: true });

    const oldChild = join(mergifyRoot, 'old-checkout');
    mkdirSync(join(oldChild, 'nested'), { recursive: true });
    writeFileSync(join(oldChild, 'nested', 'file.txt'), 'remove');
    setAge(oldChild, nowMs, AUTOMATION_WORK_MIN_AGE_MS + 60_000);

    const recentChild = join(mergifyRoot, 'recent-checkout');
    mkdirSync(recentChild, { recursive: true });
    setAge(recentChild, nowMs, AUTOMATION_WORK_MIN_AGE_MS - 60_000);

    const oldFileChild = join(landRoot, 'old-file');
    writeFileSync(oldFileChild, 'remove');
    setAge(oldFileChild, nowMs, AUTOMATION_WORK_MIN_AGE_MS + 60_000);

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, reason: 'automation-checkout-work', removed: 2 });
    expect(existsSync(mergifyRoot)).toBe(true);
    expect(existsSync(landRoot)).toBe(true);
    expect(existsSync(oldChild)).toBe(false);
    expect(existsSync(oldFileChild)).toBe(false);
    expect(existsSync(recentChild)).toBe(true);
  });
});

describe('reclaimHourlySnapshots', () => {
  it('applies the exported hourly retention helpers and leaves snapshots within the limit alone', async () => {
    const acted = makeHome();
    const actedBackupDir = join(acted.home, 'db-backups');
    seedHourly(actedBackupDir, 4);
    writeFileSync(join(actedBackupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'keep');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const actedResult = await reclaimHourlySnapshots({
      invokerHome: acted.home,
      snapshotHelpers: { pruneHourlySnapshots, hourlySnapshotRetention },
    });

    expect(actedResult).toMatchObject({ ok: true, reason: 'hourly-snapshots', removed: 2 });
    expect(hourlyBaseNames(actedBackupDir)).toHaveLength(2);
    expect(existsSync(join(actedBackupDir, 'invoker.db.hourly-auto-20260101-000000-000Z'))).toBe(false);
    expect(existsSync(join(actedBackupDir, 'invoker.db.hourly-auto-20260101-000003-000Z'))).toBe(true);
    expect(existsSync(join(actedBackupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);

    const leftAlone = makeHome();
    const leftAloneBackupDir = join(leftAlone.home, 'db-backups');
    seedHourly(leftAloneBackupDir, 2);

    const leftAloneResult = await reclaimHourlySnapshots({
      invokerHome: leftAlone.home,
      snapshotHelpers: { pruneHourlySnapshots, hourlySnapshotRetention },
    });

    expect(leftAloneResult).toMatchObject({ ok: true, reason: 'hourly-snapshots', removed: 0 });
    expect(hourlyBaseNames(leftAloneBackupDir)).toHaveLength(2);
  });
});

describe('trimInvokerLogs', () => {
  it('trims known large log files to their tail and leaves small or non-matching logs untouched', () => {
    const { home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const invokerContent = 'a'.repeat(120) + 'invoker-tail';
    writeFileSync(invokerLog, invokerContent);

    const guiLog = join(home, 'gui.log');
    const guiContent = 'small-gui-log';
    writeFileSync(guiLog, guiContent);

    const taskOutputFull = join(home, 'task-output', 'full');
    mkdirSync(taskOutputFull, { recursive: true });
    const hashLog = join(taskOutputFull, `${'a'.repeat(64)}.log`);
    const hashContent = 'b'.repeat(120) + 'hash-tail';
    writeFileSync(hashLog, hashContent);

    const nonMatchingLog = join(taskOutputFull, 'not-a-task-output-hash.log');
    const nonMatchingContent = 'c'.repeat(140);
    writeFileSync(nonMatchingLog, nonMatchingContent);

    const result = trimInvokerLogs({ invokerHome: home, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ ok: true, reason: 'log-trim', trimmed: 2 });
    expect(statSync(invokerLog).size).toBe(20);
    expect(readFileSync(invokerLog, 'utf8')).toBe(invokerContent.slice(-20));
    expect(readFileSync(guiLog, 'utf8')).toBe(guiContent);
    expect(statSync(hashLog).size).toBe(20);
    expect(readFileSync(hashLog, 'utf8')).toBe(hashContent.slice(-20));
    expect(readFileSync(nonMatchingLog, 'utf8')).toBe(nonMatchingContent);
  });
});
