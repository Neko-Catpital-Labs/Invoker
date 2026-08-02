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
import { afterEach, describe, expect, it } from 'vitest';

import {
  reapAutomationCheckoutWorkDirs,
  reapDeletingOrphanEntries,
  pruneHourlySnapshotsToRetention,
  trimInvokerHomeLogs,
  type ReaperRemoteScriptRunner,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

function makeTempHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  tempDirs.push(root);
  return { root, home };
}

function setAge(path: string, nowMs: number, ageMs: number): void {
  const t = new Date(nowMs - ageMs);
  utimesSync(path, t, t);
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
    (name) => name.startsWith('invoker.db.hourly-auto-')
      && !name.endsWith('-wal')
      && !name.endsWith('-shm'),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reapDeletingOrphanEntries', () => {
  it('removes old dot-deleting entries locally and runs the same narrow sweep remotely', async () => {
    const { root, home } = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const recentOrphan = join(home, 'worktrees.deleting.456');
    const ordinaryDir = join(home, 'merge-clones');
    mkdirSync(oldOrphan, { recursive: true });
    mkdirSync(recentOrphan, { recursive: true });
    mkdirSync(ordinaryDir, { recursive: true });
    writeFileSync(join(oldOrphan, 'file.txt'), 'x');
    setAge(oldOrphan, nowMs, 31 * 60 * 1000);
    setAge(recentOrphan, nowMs, 5 * 60 * 1000);
    setAge(ordinaryDir, nowMs, 31 * 60 * 1000);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'remote-a',
      connection: { host: 'remote.example', user: 'invoker', sshKeyPath: '/tmp/key' },
      remotePath: '~/.invoker',
    }];
    const remoteCalls: Array<{ target: RemoteDiskTarget; script: string }> = [];
    const runRemoteScript: ReaperRemoteScriptRunner = async (target, script) => {
      remoteCalls.push({ target, script });
      return '[reaper-reclaim] deleting-orphans removed=2 home=/home/invoker/.invoker';
    };

    const result = await reapDeletingOrphanEntries({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets,
      runRemoteScript,
    });

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(ordinaryDir)).toBe(true);
    expect(result.removed).toEqual([oldOrphan]);
    expect(result.remote).toEqual([expect.objectContaining({
      targetKey: 'ssh:remote-a ~/.invoker',
      ok: true,
      removed: 2,
    })]);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].script).toContain("-name '*.deleting.*'");
    expect(remoteCalls[0].script).toContain('-mmin +30');
    expect(remoteCalls[0].script).not.toContain('merge-clones"');
    expect(remoteCalls[0].script).not.toContain('worktrees"');
  });

  it('leaves recent dot-deleting entries untouched', async () => {
    const { root, home } = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const recentOrphan = join(home, 'repos.deleting.789');
    mkdirSync(recentOrphan, { recursive: true });
    setAge(recentOrphan, nowMs, 29 * 60 * 1000);

    const result = await reapDeletingOrphanEntries({ invokerHome: home, userHome: root, nowMs });

    expect(existsSync(recentOrphan)).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([recentOrphan]);
  });
});

describe('reapAutomationCheckoutWorkDirs', () => {
  it('removes old immediate children from both automation checkout locations', () => {
    const { root, home } = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const requeueParent = join(home, 'mergify-admin-requeue-work');
    const bypassParent = join(home, 'land-admin-bypass-work');
    const oldRequeue = join(requeueParent, 'repo-a');
    const oldBypass = join(bypassParent, 'repo-b');
    mkdirSync(oldRequeue, { recursive: true });
    mkdirSync(oldBypass, { recursive: true });
    writeFileSync(join(oldRequeue, 'file.txt'), 'x');
    setAge(oldRequeue, nowMs, 49 * 60 * 60 * 1000);
    setAge(oldBypass, nowMs, 49 * 60 * 60 * 1000);

    const result = reapAutomationCheckoutWorkDirs({ invokerHome: home, userHome: root, nowMs });

    expect(existsSync(requeueParent)).toBe(true);
    expect(existsSync(bypassParent)).toBe(true);
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(oldBypass)).toBe(false);
    expect(result.removed.sort()).toEqual([oldBypass, oldRequeue].sort());
  });

  it('leaves recent immediate children and the checkout locations untouched', () => {
    const { root, home } = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const parent = join(home, 'mergify-admin-requeue-work');
    const recentChild = join(parent, 'repo-fresh');
    mkdirSync(recentChild, { recursive: true });
    setAge(recentChild, nowMs, 47 * 60 * 60 * 1000);

    const result = reapAutomationCheckoutWorkDirs({ invokerHome: home, userHome: root, nowMs });

    expect(existsSync(parent)).toBe(true);
    expect(existsSync(recentChild)).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([recentChild]);
  });
});

describe('pruneHourlySnapshotsToRetention', () => {
  it('prunes hourly snapshots using the existing retention resolver', () => {
    const { home } = makeTempHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    expect(pruneHourlySnapshotsToRetention({ invokerHome: home })).toBe(2);

    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
  });

  it('leaves hourly snapshots alone when already within the existing limit', () => {
    const { home } = makeTempHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    expect(pruneHourlySnapshotsToRetention({ invokerHome: home })).toBe(0);
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimInvokerHomeLogs', () => {
  it('trims only known large log files and known log globs to their tail', () => {
    const { root, home } = makeTempHome();
    const invokerLog = join(home, 'invoker.log');
    const uiLog = join(home, 'ui-task-graph-events.jsonl');
    const unknownLog = join(home, 'other.log');
    writeFileSync(invokerLog, '0123456789abcdef');
    writeFileSync(uiLog, 'abcdefghijklmnop');
    writeFileSync(unknownLog, '0123456789abcdef');

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 10,
      keepBytes: 4,
    });

    expect(readFileSync(invokerLog, 'utf8')).toBe('cdef');
    expect(readFileSync(uiLog, 'utf8')).toBe('mnop');
    expect(readFileSync(unknownLog, 'utf8')).toBe('0123456789abcdef');
    expect(result.trimmed.sort()).toEqual([invokerLog, uiLog].sort());
  });

  it('leaves known log files untouched while they are below the trim threshold', () => {
    const { root, home } = makeTempHome();
    const guiLog = join(home, 'gui.log');
    writeFileSync(guiLog, 'small');
    const before = statSync(guiLog).size;

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 10,
      keepBytes: 4,
    });

    expect(readFileSync(guiLog, 'utf8')).toBe('small');
    expect(statSync(guiLog).size).toBe(before);
    expect(result.trimmed).toEqual([]);
    expect(result.kept).toEqual([guiLog]);
  });
});
