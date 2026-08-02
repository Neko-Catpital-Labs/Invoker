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
  pruneHourlySnapshotBacklog,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  trimInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

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
      `hourly-${i}`,
    );
  }
}

function hourlyBaseNames(backupDir: string): string[] {
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
  it('removes only stale dot-deleting entries and runs the same remote target set', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const stale = join(home, 'worktrees.deleting.123');
    const fresh = join(home, 'repos.deleting.456');
    const oldNonMatch = join(home, 'old-worktrees');
    mkdirSync(join(stale, 'child'), { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(oldNonMatch, { recursive: true });
    setAge(stale, nowMs, 31 * 60 * 1000);
    setAge(fresh, nowMs, 29 * 60 * 1000);
    setAge(oldNonMatch, nowMs, 2 * 60 * 60 * 1000);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'remote-1',
      connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
      remotePath: '~/.invoker',
    }];
    const runRemoteScript = vi.fn(async () => 'remote-ok');

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets,
      nowMs,
      runRemoteScript,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(oldNonMatch)).toBe(true);
    expect(results.find((r) => r.targetKey.startsWith('local '))?.removed).toBe(1);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0]?.[0]).toBe(remoteTargets[0]);
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain("-name '*.deleting.*'");
    expect(script).toContain('-mmin +30');
    expect(script).not.toContain('remove_path');
    expect(script).not.toContain('$INVOKER_HOME/worktrees');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes only immediate children older than forty-eight hours', () => {
    const { home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const staleRequeue = join(requeueRoot, 'wf-old');
    const freshRequeue = join(requeueRoot, 'wf-fresh');
    const staleBypass = join(bypassRoot, 'land-old');
    mkdirSync(staleRequeue, { recursive: true });
    mkdirSync(join(freshRequeue, 'nested-old'), { recursive: true });
    mkdirSync(staleBypass, { recursive: true });
    writeFileSync(join(staleRequeue, 'file.txt'), 'remove');
    writeFileSync(join(freshRequeue, 'nested-old', 'file.txt'), 'keep');
    setAge(staleRequeue, nowMs, 49 * 60 * 60 * 1000);
    setAge(freshRequeue, nowMs, 47 * 60 * 60 * 1000);
    setAge(join(freshRequeue, 'nested-old'), nowMs, 49 * 60 * 60 * 1000);
    setAge(staleBypass, nowMs, 49 * 60 * 60 * 1000);

    const results = reclaimAutomationCheckoutWork({ invokerHome: home, nowMs });

    expect(results.map((r) => r.removed)).toEqual([1, 1]);
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(staleRequeue)).toBe(false);
    expect(existsSync(staleBypass)).toBe(false);
    expect(existsSync(freshRequeue)).toBe(true);
    expect(existsSync(join(freshRequeue, 'nested-old'))).toBe(true);
  });
});

describe('pruneHourlySnapshotBacklog', () => {
  it('uses the configured hourly retention and leaves retained/non-hourly snapshots alone', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'keep');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const removed = pruneHourlySnapshotBacklog({ invokerHome: home });

    expect(removed).toBe(2);
    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);
  });
});

describe('trimInvokerLogs', () => {
  it('keeps only the tail of oversized known logs and leaves small or unknown logs alone', () => {
    const { home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const autoLog = join(home, 'auto-fix-ci-self-prs.log');
    const unknownLog = join(home, 'other.log');
    writeFileSync(invokerLog, '0123456789ABCDE');
    writeFileSync(guiLog, 'small');
    writeFileSync(autoLog, 'abcdefghijklmno');
    writeFileSync(unknownLog, 'ABCDEFGHIJKLMNO');

    const results = trimInvokerLogs({
      invokerHome: home,
      thresholdBytes: 10,
      tailBytes: 5,
    });

    expect(results.filter((r) => r.action === 'trimmed').map((r) => r.path).sort()).toEqual([
      autoLog,
      invokerLog,
    ].sort());
    expect(readFileSync(invokerLog, 'utf8')).toBe('ABCDE');
    expect(readFileSync(autoLog, 'utf8')).toBe('klmno');
    expect(readFileSync(guiLog, 'utf8')).toBe('small');
    expect(statSync(guiLog).size).toBe(5);
    expect(readFileSync(unknownLog, 'utf8')).toBe('ABCDEFGHIJKLMNO');
  });
});
