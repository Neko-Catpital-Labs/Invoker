import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_CHECKOUT_WORK_DIRS,
  AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  LOG_RETAIN_BYTES,
  LOG_TRIM_THRESHOLD_BYTES,
  pruneHourlySnapshotsForReaper,
  reapAutomationCheckoutWork,
  reapDeletingOrphans,
  trimInvokerLogFiles,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const NOW_MS = Date.parse('2026-08-02T12:00:00.000Z');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, ageMs: number): void {
  const when = new Date(NOW_MS - ageMs);
  utimesSync(path, when, when);
}

function writeSnapshot(backupDir: string, name: string): void {
  writeFileSync(join(backupDir, name), 'db');
}

describe('reapDeletingOrphans', () => {
  it('removes old dot-deleting children and invokes configured remote targets', async () => {
    const { root, home } = makeHome();
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    mkdirSync(oldOrphan, { recursive: true });
    writeFileSync(join(oldOrphan, 'file.txt'), 'x');
    setAge(oldOrphan, DELETING_ORPHAN_MIN_AGE_MS + 60_000);
    mkdirSync(join(home, 'worktrees', 'keep'), { recursive: true });
    setAge(join(home, 'worktrees'), DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    let remoteScript = '';
    const results = await reapDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
      remoteTargets: [
        {
          name: 'remote-1',
          connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
          remotePath: '~/.invoker',
        },
      ],
      runRemoteScript: async (_target, script) => {
        remoteScript = script;
        return '[reaper-reclaim] deleting-orphans removed=2 home=/home/u/.invoker\n';
      },
    });

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(join(home, 'worktrees', 'keep'))).toBe(true);
    expect(results.map((r) => r.targetKey)).toEqual([
      `local ${home}`,
      'ssh:remote-1 ~/.invoker',
    ]);
    expect(remoteScript).toContain("-name '*.deleting.*'");
    expect(remoteScript).toContain('-mmin +30');
  });

  it('leaves recent dot-deleting children untouched', async () => {
    const { root, home } = makeHome();
    const recentOrphan = join(home, 'repos.deleting.456');
    mkdirSync(recentOrphan, { recursive: true });
    writeFileSync(join(recentOrphan, 'file.txt'), 'x');
    setAge(recentOrphan, 5 * 60 * 1000);

    await reapDeletingOrphans({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(existsSync(recentOrphan)).toBe(true);
  });
});

describe('reapAutomationCheckoutWork', () => {
  it('removes old immediate children from both automation checkout roots', () => {
    const { root, home } = makeHome();
    for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const workRoot = join(home, dirName);
      const oldChild = join(workRoot, '123');
      mkdirSync(oldChild, { recursive: true });
      writeFileSync(join(oldChild, 'file.txt'), 'x');
      setAge(oldChild, AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS + 60_000);
    }

    reapAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const workRoot = join(home, dirName);
      expect(existsSync(workRoot)).toBe(true);
      expect(existsSync(join(workRoot, '123'))).toBe(false);
    }
  });

  it('leaves recent automation checkout children untouched', () => {
    const { root, home } = makeHome();
    const workRoot = join(home, 'mergify-admin-requeue-work');
    const recentChild = join(workRoot, '789');
    mkdirSync(recentChild, { recursive: true });
    writeFileSync(join(recentChild, 'file.txt'), 'x');
    setAge(recentChild, 60 * 60 * 1000);

    reapAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(existsSync(recentChild)).toBe(true);
  });
});

describe('pruneHourlySnapshotsForReaper', () => {
  it('prunes hourly snapshots past the exported retention limit', async () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';
    writeSnapshot(backupDir, 'invoker.db.hourly-auto-20260802-090000-000Z');
    writeSnapshot(backupDir, 'invoker.db.hourly-auto-20260802-100000-000Z');
    writeSnapshot(backupDir, 'invoker.db.hourly-auto-20260802-110000-000Z');
    writeSnapshot(backupDir, 'invoker.db.hourly-auto-20260802-090000-000Z-wal');
    writeSnapshot(backupDir, 'invoker.db.before-delete-all-20260802-080000-000Z');

    const removed = await pruneHourlySnapshotsForReaper({ invokerHome: home });

    expect(removed).toBe(2);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260802-090000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260802-090000-000Z-wal'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260802-100000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260802-110000-000Z'))).toBe(true);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260802-080000-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when the count is within retention', async () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';
    writeSnapshot(backupDir, 'invoker.db.hourly-auto-20260802-110000-000Z');

    const removed = await pruneHourlySnapshotsForReaper({ invokerHome: home });

    expect(removed).toBe(0);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260802-110000-000Z'))).toBe(true);
  });
});

describe('trimInvokerLogFiles', () => {
  it('trims known log files and the slack-manager log glob once they exceed the size limit', () => {
    const { home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const slackLog = join(home, 'slack-manager', 'local-slack-manager.log');
    mkdirSync(join(home, 'slack-manager'), { recursive: true });
    writeFileSync(invokerLog, '0123456789'.repeat(14));
    writeFileSync(slackLog, 'abcdefghij'.repeat(14));

    trimInvokerLogFiles({ invokerHome: home, thresholdBytes: 100, retainBytes: 20 });

    expect(statSync(invokerLog).size).toBe(20);
    expect(readFileSync(invokerLog, 'utf8')).toBe('01234567890123456789');
    expect(statSync(slackLog).size).toBe(20);
    expect(readFileSync(slackLog, 'utf8')).toBe('abcdefghijabcdefghij');
  });

  it('leaves small known logs and unknown large files untouched', () => {
    const { home } = makeHome();
    const smallLog = join(home, 'gui.log');
    const unknownLog = join(home, 'unknown.log');
    writeFileSync(smallLog, 'small');
    writeFileSync(unknownLog, 'x'.repeat(140));

    trimInvokerLogFiles({
      invokerHome: home,
      thresholdBytes: LOG_TRIM_THRESHOLD_BYTES / 1024 / 1024,
      retainBytes: LOG_RETAIN_BYTES / 1024 / 1024,
    });

    expect(readFileSync(smallLog, 'utf8')).toBe('small');
    expect(statSync(unknownLog).size).toBe(140);
  });
});
