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

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  AUTOMATION_CHECKOUT_DIRS,
  AUTOMATION_CHECKOUT_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  pruneHourlySnapshotRetention,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  trimInvokerHomeLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const NOW_MS = Date.UTC(2026, 7, 2, 12, 0, 0);

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

function agePath(path: string, ageMs: number): void {
  const time = new Date(NOW_MS - ageMs);
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

describe('reclaimDeletingOrphans', () => {
  it('removes old dot-deleting orphans locally and reaches configured remotes', async () => {
    const { root, home } = makeHome();
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const oldNonMatch = join(home, 'merge-clones.old.123');
    mkdirSync(join(oldOrphan, 'stale'), { recursive: true });
    mkdirSync(oldNonMatch, { recursive: true });
    agePath(oldOrphan, DELETING_ORPHAN_MIN_AGE_MS + 60_000);
    agePath(oldNonMatch, DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const remoteTargets: RemoteDiskTarget[] = [
      {
        name: 'remote-a',
        connection: { host: 'host', user: 'invoker', sshKeyPath: '/tmp/key' },
        remotePath: '~/.invoker',
      },
    ];
    const runRemoteScript = vi.fn(async () => 'removed=1 errors=0');

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
      remoteTargets,
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, removed: 1, reason: 'deleting-orphans' });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(oldNonMatch)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0]?.[0]).toBe(remoteTargets[0]);
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain(".deleting.");
    expect(script).toContain('-mmin +30');
    expect(script).not.toContain('remove_path');
    expect(script).not.toContain('$INVOKER_HOME/runtime');
    expect(script).not.toContain('$INVOKER_HOME/repos');
  });

  it('leaves recent dot-deleting orphans alone', async () => {
    const { root, home } = makeHome();
    const recentOrphan = join(home, 'repos.deleting.456');
    mkdirSync(join(recentOrphan, 'active'), { recursive: true });
    agePath(recentOrphan, 5 * 60 * 1000);

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
    });

    expect(results[0]).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(recentOrphan)).toBe(true);
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes old immediate checkout work children and keeps the parents', () => {
    const { root, home } = makeHome();
    for (const dir of AUTOMATION_CHECKOUT_DIRS) {
      const parent = join(home, dir);
      const oldChild = join(parent, '123');
      mkdirSync(join(oldChild, 'repo'), { recursive: true });
      agePath(oldChild, AUTOMATION_CHECKOUT_MIN_AGE_MS + 60_000);
    }

    const result = reclaimAutomationCheckoutWork({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ ok: true, reason: 'automation-checkout-work', removed: 2 });
    for (const dir of AUTOMATION_CHECKOUT_DIRS) {
      const parent = join(home, dir);
      expect(existsSync(parent)).toBe(true);
      expect(readdirSync(parent)).toEqual([]);
    }
  });

  it('leaves recent checkout work children alone', () => {
    const { root, home } = makeHome();
    const parent = join(home, AUTOMATION_CHECKOUT_DIRS[0]);
    const recentChild = join(parent, 'recent');
    mkdirSync(join(recentChild, 'repo'), { recursive: true });
    agePath(recentChild, 60 * 60 * 1000);

    const result = reclaimAutomationCheckoutWork({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(recentChild)).toBe(true);
  });
});

describe('pruneHourlySnapshotRetention', () => {
  it('prunes old hourly snapshots with the existing retention resolver', async () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = await pruneHourlySnapshotRetention({ invokerHomeRoot: home });

    expect(result).toMatchObject({ ok: true, reason: 'hourly-snapshot-retention', removed: 2 });
    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
  });

  it('leaves hourly snapshots alone when they are within retention', async () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '4';

    const result = await pruneHourlySnapshotRetention({ invokerHomeRoot: home });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimInvokerHomeLogs', () => {
  it('trims large known Invoker-home logs and matching trace globs only', () => {
    const { root, home } = makeHome();
    const large = `prefix-${'x'.repeat(130)}0123456789ABCDEFGHIJ`;
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const traceLog = join(home, 'ui-task-graph-events.jsonl');
    const unrelatedLog = join(home, 'random.log');
    writeFileSync(invokerLog, large);
    writeFileSync(guiLog, large);
    writeFileSync(traceLog, large);
    writeFileSync(unrelatedLog, large);

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 100,
      keepBytes: 20,
    });

    expect(result).toMatchObject({ ok: true, reason: 'invoker-home-logs', trimmed: 3 });
    expect(readFileSync(invokerLog, 'utf8')).toBe('0123456789ABCDEFGHIJ');
    expect(readFileSync(guiLog, 'utf8')).toBe('0123456789ABCDEFGHIJ');
    expect(readFileSync(traceLog, 'utf8')).toBe('0123456789ABCDEFGHIJ');
    expect(statSync(unrelatedLog).size).toBe(Buffer.byteLength(large));
  });

  it('leaves small known Invoker-home logs alone', () => {
    const { root, home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const keepaliveLog = join(home, 'slack-manager.keepalive.log');
    writeFileSync(invokerLog, 'small invoker log');
    writeFileSync(keepaliveLog, 'small keepalive log');

    const result = trimInvokerHomeLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 100,
      keepBytes: 20,
    });

    expect(result).toMatchObject({ ok: true, trimmed: 0 });
    expect(readFileSync(invokerLog, 'utf8')).toBe('small invoker log');
    expect(readFileSync(keepaliveLog, 'utf8')).toBe('small keepalive log');
  });
});
