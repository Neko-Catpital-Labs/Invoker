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
import { afterEach, describe, expect, it } from 'vitest';

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  AUTOMATION_CHECKOUT_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  pruneHourlySnapshotsForInvokerHome,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  trimInvokerHomeLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const CONN = { host: 'h', user: 'u', sshKeyPath: '/k' };

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, nowMs: number, ageMs: number): void {
  const time = new Date(nowMs - ageMs);
  utimesSync(path, time, time);
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reclaimDeletingOrphans', () => {
  it('removes stale dot-deleting entries, leaves recent or non-matching entries, and reaches remotes', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.now();
    const stale = join(home, 'worktrees.deleting.123');
    const recent = join(home, 'repos.deleting.456');
    const nonMatching = join(home, 'worktrees-old');
    mkdirSync(join(stale, 'nested'), { recursive: true });
    mkdirSync(recent, { recursive: true });
    mkdirSync(nonMatching, { recursive: true });
    setAge(stale, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 1000);
    setAge(recent, nowMs, DELETING_ORPHAN_MIN_AGE_MS - 1000);
    setAge(nonMatching, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 1000);

    const remoteTargets: RemoteDiskTarget[] = [
      { name: 'a', connection: CONN, remotePath: '~/.invoker' },
      { name: 'b', connection: CONN, remotePath: '~/.invoker' },
    ];
    const remoteCalls: Array<{ target: RemoteDiskTarget; script: string }> = [];

    const result = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets,
      runRemoteScript: async (target, script) => {
        remoteCalls.push({ target, script });
        return `ok ${target.name}`;
      },
    });

    expect(result.local).toMatchObject({ ok: true, removed: 1 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(nonMatching)).toBe(true);
    expect(remoteCalls.map((call) => call.target.name)).toEqual(['a', 'b']);
    expect(remoteCalls[0]?.script).toContain("-name '*.deleting.*'");
    expect(remoteCalls[0]?.script).toContain('-mmin +30');
    expect(remoteCalls[0]?.script).not.toContain('pr-cron-work');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes old immediate checkout children while keeping roots and recent children', () => {
    const { root, home } = makeHome();
    const nowMs = Date.now();
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const oldChild = join(requeueRoot, 'old-checkout');
    const recentChild = join(bypassRoot, 'recent-checkout');
    mkdirSync(join(oldChild, 'repo'), { recursive: true });
    mkdirSync(recentChild, { recursive: true });
    setAge(oldChild, nowMs, AUTOMATION_CHECKOUT_MIN_AGE_MS + 1000);
    setAge(recentChild, nowMs, AUTOMATION_CHECKOUT_MIN_AGE_MS - 1000);
    setAge(requeueRoot, nowMs, AUTOMATION_CHECKOUT_MIN_AGE_MS + 1000);
    setAge(bypassRoot, nowMs, AUTOMATION_CHECKOUT_MIN_AGE_MS + 1000);

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ removed: 1, kept: 1, errors: [] });
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(oldChild)).toBe(false);
    expect(existsSync(recentChild)).toBe(true);
  });
});

describe('pruneHourlySnapshotsForInvokerHome', () => {
  it('prunes hourly snapshots beyond the exported retention and keeps retained/non-hourly snapshots', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'keep');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    expect(pruneHourlySnapshotsForInvokerHome({ invokerHome: home })).toBe(2);

    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);
  });
});

describe('trimInvokerHomeLogs', () => {
  it('trims oversized known logs and keeps small or non-matching logs untouched', () => {
    const { home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const traceLog = join(home, 'merge-trace.log');
    const otherLog = join(home, 'other.log');
    writeFileSync(invokerLog, '0123456789abcdef');
    writeFileSync(guiLog, 'small');
    writeFileSync(traceLog, 'abcdefghijklmnop');
    writeFileSync(otherLog, '0123456789abcdef');

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      triggerBytes: 10,
      keepBytes: 4,
    });

    expect(result).toEqual({ trimmed: 2, kept: 1, errors: [] });
    expect(statSync(invokerLog).size).toBe(4);
    expect(readFileSync(invokerLog, 'utf8')).toBe('cdef');
    expect(readFileSync(guiLog, 'utf8')).toBe('small');
    expect(readFileSync(traceLog, 'utf8')).toBe('mnop');
    expect(readFileSync(otherLog, 'utf8')).toBe('0123456789abcdef');
  });
});
