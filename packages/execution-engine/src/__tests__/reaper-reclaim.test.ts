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
  buildDeletingOrphanReclaimScript,
  reclaimHourlySnapshotRetention,
  reclaimStaleAutomationCheckoutWork,
  reclaimStaleDeletingOrphans,
  REAPER_AUTOMATION_WORK_DIRS,
  REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES,
  trimKnownInvokerHomeLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];
const originalHourlyRetention = process.env.INVOKER_HOURLY_BACKUP_RETENTION;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHourlyRetention === undefined) {
    delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  } else {
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = originalHourlyRetention;
  }
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return home;
}

function setAgeMs(path: string, ageMs: number, nowMs: number): void {
  const date = new Date(nowMs - ageMs);
  utimesSync(path, date, date);
}

describe('reclaimStaleDeletingOrphans', () => {
  it('removes old dot-deleting orphans and leaves recent or non-matching entries', async () => {
    const nowMs = Date.UTC(2026, 7, 2, 12);
    const home = tempHome();
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const recentOrphan = join(home, 'worktrees.deleting.456');
    const oldNormal = join(home, 'repos');
    mkdirSync(join(oldOrphan, 'child'), { recursive: true });
    writeFileSync(join(oldOrphan, 'child', 'file.txt'), 'old');
    mkdirSync(recentOrphan, { recursive: true });
    mkdirSync(oldNormal, { recursive: true });
    setAgeMs(oldOrphan, 31 * 60 * 1000, nowMs);
    setAgeMs(recentOrphan, 5 * 60 * 1000, nowMs);
    setAgeMs(oldNormal, 31 * 60 * 1000, nowMs);

    const results = await reclaimStaleDeletingOrphans({
      invokerHome: home,
      userHome: join(home, '..'),
      nowMs,
    });

    expect(results[0]).toMatchObject({ ok: true, reason: 'deleting-orphans', removed: 1 });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(oldNormal)).toBe(true);
  });

  it('runs the narrow dot-deleting script for configured remote targets', async () => {
    const remoteTargets: RemoteDiskTarget[] = [
      {
        name: 'host-a',
        remotePath: '~/.invoker',
        connection: { host: 'example.invalid', user: 'invoker', sshKeyPath: '/tmp/key' },
      },
    ];
    const runRemoteScript = vi.fn(async () => '[reaper-reclaim] deleting-orphans removed=1');

    const results = await reclaimStaleDeletingOrphans({
      invokerHome: tempHome(),
      remoteTargets,
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ targetKey: 'ssh:host-a ~/.invoker', ok: true });
    expect(runRemoteScript).toHaveBeenCalledWith(remoteTargets[0], expect.stringContaining("*.deleting.*"));
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain(
      `-mmin +${REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES}`,
    );
    expect(runRemoteScript.mock.calls[0]?.[1]).not.toContain('merge-clones');
    expect(runRemoteScript.mock.calls[0]?.[1]).not.toContain('worktrees');
  });

  it('builds a remote script with the same path guard as disk cleanup', () => {
    const script = buildDeletingOrphanReclaimScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain('mindepth 1 -maxdepth 1');
    expect(script).toContain("*.deleting.*");
  });
});

describe('reclaimStaleAutomationCheckoutWork', () => {
  it('removes old immediate checkout-work children and leaves fresh children and roots', () => {
    const nowMs = Date.UTC(2026, 7, 2, 12);
    const home = tempHome();

    for (const dirName of REAPER_AUTOMATION_WORK_DIRS) {
      const root = join(home, dirName);
      const oldChild = join(root, 'old-child');
      const freshChild = join(root, 'fresh-child');
      mkdirSync(join(oldChild, 'nested'), { recursive: true });
      writeFileSync(join(oldChild, 'nested', 'file.txt'), 'old');
      mkdirSync(freshChild, { recursive: true });
      setAgeMs(oldChild, 49 * 60 * 60 * 1000, nowMs);
      setAgeMs(freshChild, 60 * 60 * 1000, nowMs);
    }

    const result = reclaimStaleAutomationCheckoutWork({
      invokerHome: home,
      userHome: join(home, '..'),
      nowMs,
    });

    expect(result).toMatchObject({ ok: true, reason: 'automation-checkout-work', removed: 2 });
    for (const dirName of REAPER_AUTOMATION_WORK_DIRS) {
      const root = join(home, dirName);
      expect(existsSync(root)).toBe(true);
      expect(readdirSync(root)).toEqual(['fresh-child']);
    }
  });
});

describe('reclaimHourlySnapshotRetention', () => {
  it('prunes hourly snapshots above the exported retention limit and leaves retained/manual snapshots', () => {
    const home = tempHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const oldHourly = join(backupDir, 'invoker.db.hourly-auto-20260802-010000-000Z');
    const keptHourlyA = join(backupDir, 'invoker.db.hourly-auto-20260802-020000-000Z');
    const keptHourlyB = join(backupDir, 'invoker.db.hourly-auto-20260802-030000-000Z');
    const manual = join(backupDir, 'invoker.db.before-delete-all-20260802-000000-000Z');
    writeFileSync(oldHourly, 'old');
    writeFileSync(`${oldHourly}-wal`, 'old-wal');
    writeFileSync(keptHourlyA, 'keep-a');
    writeFileSync(keptHourlyB, 'keep-b');
    writeFileSync(manual, 'manual');

    expect(reclaimHourlySnapshotRetention({ invokerHome: home })).toBe(1);

    expect(existsSync(oldHourly)).toBe(false);
    expect(existsSync(`${oldHourly}-wal`)).toBe(false);
    expect(existsSync(keptHourlyA)).toBe(true);
    expect(existsSync(keptHourlyB)).toBe(true);
    expect(existsSync(manual)).toBe(true);
  });
});

describe('trimKnownInvokerHomeLogs', () => {
  it('trims oversized known logs and leaves small or unknown files alone', () => {
    const home = tempHome();
    const largeFixed = join(home, 'invoker.log');
    const largeGlob = join(home, 'ui-task-graph-events.jsonl');
    const smallKnown = join(home, 'gui.log');
    const unknownLarge = join(home, 'random.log');
    writeFileSync(largeFixed, `${'a'.repeat(190)}fixed-tail`);
    writeFileSync(largeGlob, `${'b'.repeat(190)}glob-tail`);
    writeFileSync(smallKnown, 'small');
    writeFileSync(unknownLarge, 'x'.repeat(220));

    const result = trimKnownInvokerHomeLogs({
      invokerHome: home,
      userHome: join(home, '..'),
      thresholdBytes: 100,
      keepBytes: 20,
    });

    expect(result).toMatchObject({ ok: true, reason: 'known-log-trim', trimmed: 2 });
    expect(statSync(largeFixed).size).toBe(20);
    expect(readFileSync(largeFixed, 'utf8')).toBe('a'.repeat(10) + 'fixed-tail');
    expect(statSync(largeGlob).size).toBe(20);
    expect(readFileSync(largeGlob, 'utf8')).toBe('b'.repeat(11) + 'glob-tail');
    expect(readFileSync(smallKnown, 'utf8')).toBe('small');
    expect(statSync(unknownLarge).size).toBe(220);
  });
});
