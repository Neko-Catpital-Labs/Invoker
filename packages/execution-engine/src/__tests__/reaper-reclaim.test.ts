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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  AUTOMATION_CHECKOUT_WORK_DIRS,
  buildDeletingOrphanReclaimScript,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshots,
  trimInvokerHomeLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeInvokerHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setMtime(path: string, nowMs: number, ageMs: number): void {
  const when = new Date(nowMs - ageMs);
  utimesSync(path, when, when);
}

describe('reclaimDeletingOrphans', () => {
  it('removes only dot-deleting entries older than thirty minutes and invokes remote targets', async () => {
    const { root, home } = makeInvokerHome();
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const recentOrphan = join(home, 'worktrees.deleting.456');
    const normalDir = join(home, 'worktrees');
    mkdirSync(oldOrphan, { recursive: true });
    mkdirSync(recentOrphan, { recursive: true });
    mkdirSync(normalDir, { recursive: true });
    writeFileSync(join(oldOrphan, 'file.txt'), 'remove');
    writeFileSync(join(recentOrphan, 'file.txt'), 'keep');
    writeFileSync(join(normalDir, 'file.txt'), 'keep');
    setMtime(oldOrphan, nowMs, 31 * 60 * 1000);
    setMtime(recentOrphan, nowMs, 5 * 60 * 1000);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'a',
      connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
      remotePath: '~/.invoker',
    }];
    const runRemoteScript = vi.fn(async () => '__INVOKER_REAPER_REMOVED__=2\n');

    const results = await reclaimDeletingOrphans({
      localPath: home,
      userHome: root,
      remoteTargets,
      nowMs,
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, reason: 'stale-deleting-orphans', removed: 1 });
    expect(results[1]).toMatchObject({ ok: true, reason: 'stale-deleting-orphans', removed: 2 });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(normalDir)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledWith(remoteTargets[0], expect.any(String));

    const script = runRemoteScript.mock.calls[0]?.[1] as string;
    expect(script).toContain('-mmin +30');
    expect(script).toContain("*'.deleting.'*)");
    expect(script).not.toContain('$INVOKER_HOME/runtime');
    expect(script).not.toContain('$INVOKER_HOME/worktrees');
    expect(buildDeletingOrphanReclaimScript('~/.invoker')).toContain('Refusing unsafe INVOKER_HOME');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes only immediate automation checkout children older than forty-eight hours', () => {
    const { root, home } = makeInvokerHome();
    const nowMs = Date.UTC(2026, 0, 2, 0, 0, 0);
    const oldChildren: string[] = [];
    const recentChildren: string[] = [];

    for (const dirname of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const parent = join(home, dirname);
      const oldChild = join(parent, 'old-work');
      const recentChild = join(parent, 'recent-work');
      mkdirSync(oldChild, { recursive: true });
      mkdirSync(recentChild, { recursive: true });
      writeFileSync(join(oldChild, 'file.txt'), 'remove');
      writeFileSync(join(recentChild, 'file.txt'), 'keep');
      setMtime(oldChild, nowMs, 49 * 60 * 60 * 1000);
      setMtime(recentChild, nowMs, 60 * 60 * 1000);
      oldChildren.push(oldChild);
      recentChildren.push(recentChild);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, reason: 'automation-checkout-work', removed: 2 });
    for (const dirname of AUTOMATION_CHECKOUT_WORK_DIRS) {
      expect(existsSync(join(home, dirname))).toBe(true);
    }
    for (const child of oldChildren) {
      expect(existsSync(child)).toBe(false);
    }
    for (const child of recentChildren) {
      expect(existsSync(child)).toBe(true);
    }
  });
});

describe('reclaimHourlySnapshots', () => {
  it('prunes snapshots over the exported retention limit and leaves retained/non-hourly snapshots alone', () => {
    const { root, home } = makeInvokerHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    const oldHourly = join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z');
    const retainedHourly = join(backupDir, 'invoker.db.hourly-auto-20260102-000000-000Z');
    const manualSnapshot = join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z');
    writeFileSync(oldHourly, 'remove');
    writeFileSync(`${oldHourly}-wal`, 'remove-sidecar');
    writeFileSync(retainedHourly, 'keep');
    writeFileSync(manualSnapshot, 'keep');

    const previous = process.env.INVOKER_HOURLY_BACKUP_RETENTION;
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';
    try {
      const result = reclaimHourlySnapshots({ invokerHome: home, userHome: root });

      expect(result).toMatchObject({ ok: true, reason: 'hourly-snapshot-prune', removed: 1 });
      expect(existsSync(oldHourly)).toBe(false);
      expect(existsSync(`${oldHourly}-wal`)).toBe(false);
      expect(existsSync(retainedHourly)).toBe(true);
      expect(existsSync(manualSnapshot)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
      } else {
        process.env.INVOKER_HOURLY_BACKUP_RETENTION = previous;
      }
    }
  });
});

describe('trimInvokerHomeLogs', () => {
  it('keeps only the tail of oversized known logs and leaves smaller logs untouched', () => {
    const { root, home } = makeInvokerHome();
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const mergeTraceLog = join(home, 'merge-trace-extra.log');
    writeFileSync(invokerLog, 'abcdefghijklmnopqrstuvwxyz');
    writeFileSync(guiLog, 'small-log');
    writeFileSync(mergeTraceLog, '0123456789abcdef');

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 10,
      keepBytes: 6,
    });

    expect(result).toMatchObject({ ok: true, reason: 'log-trim', trimmed: 2 });
    expect(readFileSync(invokerLog, 'utf8')).toBe('uvwxyz');
    expect(readFileSync(guiLog, 'utf8')).toBe('small-log');
    expect(readFileSync(mergeTraceLog, 'utf8')).toBe('abcdef');
    expect(statSync(invokerLog).size).toBe(6);
    expect(statSync(guiLog).size).toBe(9);
  });
});
