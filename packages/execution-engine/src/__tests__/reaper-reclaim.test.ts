import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_CHECKOUT_DIR_NAMES,
  AUTOMATION_CHECKOUT_MIN_AGE_MS,
  DOT_DELETING_ORPHAN_MIN_AGE_MS,
  reclaimDeletingOrphans,
  reclaimExcessHourlySnapshots,
  reclaimStaleAutomationCheckouts,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';
import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return home;
}

function setOld(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
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

describe('reclaimDeletingOrphans', () => {
  it('removes old dot-deleting entries locally and remotely while leaving fresh entries', async () => {
    const localHome = makeHome();
    const remoteHome = makeHome();
    const oldName = 'merge-clones.deleting.123';
    const freshName = 'merge-clones.deleting.456';

    for (const home of [localHome, remoteHome]) {
      mkdirSync(join(home, oldName, 'payload'), { recursive: true });
      mkdirSync(join(home, freshName, 'payload'), { recursive: true });
      setOld(join(home, oldName), DOT_DELETING_ORPHAN_MIN_AGE_MS + 90_000);
    }

    const remoteTarget: RemoteDiskTarget = {
      name: 'remote-a',
      connection: { host: 'remote.example', user: 'invoker', sshKeyPath: '/tmp/key' },
      remotePath: remoteHome,
    };

    const results = await reclaimDeletingOrphans({
      invokerHome: localHome,
      remoteTargets: [remoteTarget],
      runRemoteScript: async (_target, script) => {
        return execFileSync('bash', ['-lc', script], { encoding: 'utf8' });
      },
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(existsSync(join(localHome, oldName))).toBe(false);
    expect(existsSync(join(localHome, freshName))).toBe(true);
    expect(existsSync(join(remoteHome, oldName))).toBe(false);
    expect(existsSync(join(remoteHome, freshName))).toBe(true);
  });
});

describe('reclaimStaleAutomationCheckouts', () => {
  it('removes old immediate children from known automation checkout dirs and leaves fresh children and parent dirs', () => {
    const home = makeHome();
    for (const dirName of AUTOMATION_CHECKOUT_DIR_NAMES) {
      const parent = join(home, dirName);
      mkdirSync(join(parent, 'old-child'), { recursive: true });
      mkdirSync(join(parent, 'fresh-child'), { recursive: true });
      setOld(join(parent, 'old-child'), AUTOMATION_CHECKOUT_MIN_AGE_MS + 60_000);
    }

    const result = reclaimStaleAutomationCheckouts({ invokerHome: home });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(2);
    for (const dirName of AUTOMATION_CHECKOUT_DIR_NAMES) {
      const parent = join(home, dirName);
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(join(parent, 'old-child'))).toBe(false);
      expect(existsSync(join(parent, 'fresh-child'))).toBe(true);
    }
  });
});

describe('reclaimExcessHourlySnapshots', () => {
  it('trims hourly snapshots to the configured retention limit', () => {
    const home = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 5);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '3';

    const result = reclaimExcessHourlySnapshots({
      invokerHome: home,
      snapshotRetention: {
        hourlySnapshotRetention,
        pruneHourlySnapshots,
      },
    });

    const remaining = readdirSync(backupDir).filter((name) => name.startsWith('invoker.db.hourly-auto-'));
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(2);
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
      'invoker.db.hourly-auto-20260101-000004-000Z',
    ]);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('rewrites oversized known logs to their recent portion and leaves small logs untouched', () => {
    const home = makeHome();
    const largeLog = join(home, 'invoker.log');
    const globbedLargeLog = join(home, 'task-output', 'full', 'attempt.log');
    const smallLog = join(home, 'gui.log');
    const sizeLimitBytes = 100;
    const keepBytes = 20;
    const largePrefix = 'a'.repeat(sizeLimitBytes - 1);
    const recentTail = 'b'.repeat(keepBytes);
    mkdirSync(join(home, 'task-output', 'full'), { recursive: true });
    writeFileSync(largeLog, `${largePrefix}${recentTail}`);
    writeFileSync(globbedLargeLog, `${largePrefix}${recentTail}`);
    writeFileSync(smallLog, 'small-log');

    const result = trimKnownInvokerLogs({ invokerHome: home, sizeLimitBytes, keepBytes });

    expect(result.ok).toBe(true);
    expect(result.trimmed).toBe(2);
    expect(readFileSync(largeLog, 'utf8')).toBe(recentTail);
    expect(readFileSync(globbedLargeLog, 'utf8')).toBe(recentTail);
    expect(readFileSync(smallLog, 'utf8')).toBe('small-log');
  });
});
