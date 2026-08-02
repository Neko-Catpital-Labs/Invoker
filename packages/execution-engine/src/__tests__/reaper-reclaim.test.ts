import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  reclaimAutomationCheckoutWorkdirs,
  reclaimDeletingOrphans,
  reclaimHourlySnapshotOverflow,
  reclaimLargeInvokerLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const NOW = Date.parse('2026-08-02T00:00:00.000Z');

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return home;
}

function touchAge(path: string, ageMs: number): void {
  const date = new Date(NOW - ageMs);
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
  it('removes dot-deleting entries older than thirty minutes and runs the remote sweep', async () => {
    const home = makeHome();
    const stale = join(home, 'merge-clones.deleting.123');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'file.txt'), 'x');
    touchAge(stale, 31 * 60 * 1000);
    const remoteTarget: RemoteDiskTarget = {
      name: 'remote-a',
      remotePath: '~/.invoker',
      connection: { host: 'remote.example', user: 'invoker', sshKeyPath: '/tmp/key' },
    };
    const runRemoteScript = vi.fn(async () => '[reaper-reclaim] deleting-orphans removed=1');

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      remoteTargets: [remoteTarget],
      nowMs: NOW,
      runRemoteScript,
    });

    expect(existsSync(stale)).toBe(false);
    expect(results[0]?.removed).toBe(1);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0]?.[0]).toBe(remoteTarget);
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain('-mmin +30');
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain('.deleting.');
  });

  it('leaves recent dot-deleting entries and old nonmatching entries alone', async () => {
    const home = makeHome();
    const recent = join(home, 'repos.deleting.456');
    const nonmatching = join(home, 'repos-delete-leftover');
    mkdirSync(recent, { recursive: true });
    mkdirSync(nonmatching, { recursive: true });
    touchAge(recent, 29 * 60 * 1000);
    touchAge(nonmatching, 2 * 60 * 60 * 1000);

    await reclaimDeletingOrphans({ invokerHome: home, nowMs: NOW });

    expect(existsSync(recent)).toBe(true);
    expect(existsSync(nonmatching)).toBe(true);
  });
});

describe('reclaimAutomationCheckoutWorkdirs', () => {
  it('removes old immediate children from both automation checkout parents', () => {
    const home = makeHome();
    const mergifyParent = join(home, 'mergify-admin-requeue-work');
    const landParent = join(home, 'land-admin-bypass-work');
    const oldMergify = join(mergifyParent, '6101');
    const oldLand = join(landParent, '6102');
    mkdirSync(oldMergify, { recursive: true });
    mkdirSync(oldLand, { recursive: true });
    touchAge(oldMergify, 49 * 60 * 60 * 1000);
    touchAge(oldLand, 49 * 60 * 60 * 1000);

    const result = reclaimAutomationCheckoutWorkdirs({ invokerHome: home, nowMs: NOW });

    expect(result.removed).toBe(2);
    expect(existsSync(oldMergify)).toBe(false);
    expect(existsSync(oldLand)).toBe(false);
    expect(existsSync(mergifyParent)).toBe(true);
    expect(existsSync(landParent)).toBe(true);
  });

  it('leaves recent automation checkout children alone', () => {
    const home = makeHome();
    const parent = join(home, 'mergify-admin-requeue-work');
    const recent = join(parent, '6103');
    mkdirSync(recent, { recursive: true });
    touchAge(recent, 47 * 60 * 60 * 1000);

    const result = reclaimAutomationCheckoutWorkdirs({ invokerHome: home, nowMs: NOW });

    expect(result.removed).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });
});

describe('reclaimHourlySnapshotOverflow', () => {
  it('prunes hourly snapshots through the exported retention resolver', async () => {
    const home = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 3);
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'manual');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';

    const result = await reclaimHourlySnapshotOverflow({ invokerHome: home });

    expect(result.removed).toBe(2);
    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
    ]);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when the pile is within retention', async () => {
    const home = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '3';

    const result = await reclaimHourlySnapshotOverflow({ invokerHome: home });

    expect(result.removed).toBe(0);
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('reclaimLargeInvokerLogs', () => {
  it('trims oversized known root logs and globbed trace logs to their tail', () => {
    const home = makeHome();
    const explicitLog = join(home, 'invoker.log');
    const globbedLog = join(home, 'ui-task-graph-events.jsonl');
    const explicitContent = Buffer.from(`old-${'a'.repeat(128)}explicit-tail`);
    const globbedContent = Buffer.from(`old-${'b'.repeat(128)}globbed-tail`);
    writeFileSync(explicitLog, explicitContent);
    writeFileSync(globbedLog, globbedContent);
    const explicitInode = lstatSync(explicitLog).ino;

    const result = reclaimLargeInvokerLogs({
      invokerHome: home,
      thresholdBytes: 100,
      retainBytes: 20,
    });

    expect(result.trimmed).toBe(2);
    expect(lstatSync(explicitLog).ino).toBe(explicitInode);
    expect(readFileSync(explicitLog)).toEqual(explicitContent.subarray(-20));
    expect(readFileSync(globbedLog)).toEqual(globbedContent.subarray(-20));
  });

  it('leaves small known logs alone', () => {
    const home = makeHome();
    const small = join(home, 'gui.log');
    writeFileSync(small, 'small-log');
    truncateSync(small, 99);

    const result = reclaimLargeInvokerLogs({
      invokerHome: home,
      thresholdBytes: 100,
      retainBytes: 20,
    });

    expect(result.trimmed).toBe(0);
    expect(readFileSync(small)).toHaveLength(99);
  });
});
