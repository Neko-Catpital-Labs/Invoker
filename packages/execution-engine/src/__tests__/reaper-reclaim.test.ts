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
  AUTOMATION_CHECKOUT_WORK_DIRS,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshotRetention,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return home;
}

function touchAge(path: string, ageMs: number, nowMs: number): void {
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
    (name) => name.startsWith('invoker.db.hourly-auto-') && !name.endsWith('-wal') && !name.endsWith('-shm'),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reclaimDeletingOrphans', () => {
  it('removes dot-deleting entries older than thirty minutes', async () => {
    const home = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12);
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    mkdirSync(oldOrphan);
    writeFileSync(join(oldOrphan, 'file.txt'), 'waste');
    touchAge(oldOrphan, 31 * 60 * 1000, nowMs);

    const result = await reclaimDeletingOrphans({ invokerHome: home, userHome: join(home, '..'), nowMs });

    expect(result[0]).toMatchObject({ ok: true, removed: 1 });
    expect(existsSync(oldOrphan)).toBe(false);
  });

  it('leaves recent dot-deleting entries and old nonmatching entries alone', async () => {
    const home = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12);
    const recentOrphan = join(home, 'worktrees.deleting.123');
    const oldNonmatch = join(home, 'worktrees.deleted.123');
    mkdirSync(recentOrphan);
    mkdirSync(oldNonmatch);
    touchAge(recentOrphan, 29 * 60 * 1000, nowMs);
    touchAge(oldNonmatch, 2 * 60 * 60 * 1000, nowMs);

    const result = await reclaimDeletingOrphans({ invokerHome: home, userHome: join(home, '..'), nowMs });

    expect(result[0]).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(oldNonmatch)).toBe(true);
  });

  it('runs the narrow dot-deleting script for configured remote targets', async () => {
    const home = makeTempHome();
    const runRemoteScript = vi.fn(async () => '[reaper-reclaim] deleting-orphans removed=1\n');

    const result = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: join(home, '..'),
      remoteTargets: [{
        name: 'remote-1',
        connection: { host: 'example.test', user: 'invoker', sshKeyPath: '/tmp/key' },
        remotePath: '~/.invoker',
      }],
      runRemoteScript,
    });

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ targetKey: 'ssh:remote-1 ~/.invoker', ok: true });
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain("-name '*.deleting.*'");
    expect(script).not.toContain('$INVOKER_HOME/worktrees');
    expect(script).not.toContain('$INVOKER_HOME/repos');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes stale immediate children from both automation checkout roots', () => {
    const home = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12);
    for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const root = join(home, dirName);
      const stale = join(root, 'stale-checkout');
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, 'file.txt'), 'waste');
      touchAge(stale, 49 * 60 * 60 * 1000, nowMs);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: join(home, '..'), nowMs });

    expect(result).toMatchObject({ ok: true, removed: 2 });
    for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      expect(existsSync(join(home, dirName))).toBe(true);
      expect(existsSync(join(home, dirName, 'stale-checkout'))).toBe(false);
    }
  });

  it('leaves recent automation checkout children untouched', () => {
    const home = makeTempHome();
    const nowMs = Date.UTC(2026, 0, 1, 12);
    const recent = join(home, 'mergify-admin-requeue-work', 'recent-checkout');
    mkdirSync(recent, { recursive: true });
    touchAge(recent, 47 * 60 * 60 * 1000, nowMs);

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: join(home, '..'), nowMs });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(recent)).toBe(true);
  });
});

describe('reclaimHourlySnapshotRetention', () => {
  it('prunes hourly snapshots using the existing retention resolver', () => {
    const home = makeTempHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = reclaimHourlySnapshotRetention({ backupDir });

    expect(result).toMatchObject({ ok: true, removed: 2 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000003-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when they are within retention', () => {
    const home = makeTempHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = reclaimHourlySnapshotRetention({ backupDir });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims oversized known logs in place to their tail window', () => {
    const home = makeTempHome();
    const logPath = join(home, 'invoker.log');
    const globLogPath = join(home, 'merge-trace.log');
    writeFileSync(logPath, '0123456789'.repeat(15));
    writeFileSync(globLogPath, 'abcdefghij'.repeat(15));

    const result = trimKnownInvokerLogs({ invokerHome: home, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ ok: true, trimmed: 2 });
    expect(statSync(logPath).size).toBe(20);
    expect(statSync(globLogPath).size).toBe(20);
    expect(readFileSync(logPath, 'utf8')).toBe('01234567890123456789');
    expect(readFileSync(globLogPath, 'utf8')).toBe('abcdefghijabcdefghij');
  });

  it('leaves small known logs and nonmatching logs untouched', () => {
    const home = makeTempHome();
    const smallLog = join(home, 'gui.log');
    const nonmatchingLog = join(home, 'other.log');
    writeFileSync(smallLog, 'small');
    writeFileSync(nonmatchingLog, '0123456789'.repeat(15));

    const result = trimKnownInvokerLogs({ invokerHome: home, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ ok: true, trimmed: 0 });
    expect(readFileSync(smallLog, 'utf8')).toBe('small');
    expect(statSync(nonmatchingLog).size).toBe(150);
  });
});
