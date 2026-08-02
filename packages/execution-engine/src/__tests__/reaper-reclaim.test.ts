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
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_WORK_MIN_AGE_MS,
  buildDeletingOrphanReclaimScript,
  DELETING_ORPHAN_MIN_AGE_MS,
  reclaimAdminWorkDirs,
  reclaimDeletingOrphans,
  reclaimHourlySnapshots,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const NOW_MS = Date.parse('2026-08-02T12:00:00.000Z');

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function age(path: string, ageMs: number): void {
  const date = new Date(NOW_MS - ageMs);
  utimesSync(path, date, date);
}

function writeBytes(path: string, bytes: number, fill = 'x'): void {
  writeFileSync(path, Buffer.alloc(bytes, fill));
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
      name.startsWith('invoker.db.hourly-auto-')
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

describe('reclaimDeletingOrphans', () => {
  it('removes old dot-deleting entries locally and runs the same narrow check remotely', async () => {
    const { root, home } = makeHome();
    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const recentOrphan = join(home, 'repos.deleting.456');
    const nonOrphan = join(home, 'worktrees-old');
    mkdirSync(oldOrphan);
    mkdirSync(recentOrphan);
    mkdirSync(nonOrphan);
    age(oldOrphan, DELETING_ORPHAN_MIN_AGE_MS + 1_000);
    age(recentOrphan, DELETING_ORPHAN_MIN_AGE_MS - 1_000);
    age(nonOrphan, DELETING_ORPHAN_MIN_AGE_MS + 1_000);

    const runRemoteScript = vi.fn(async () => 'remote ok');
    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
      remoteTargets: [
        {
          name: 'worker-a',
          connection: { host: 'worker-a.example', user: 'invoker', sshKeyPath: '/tmp/key' },
          remotePath: '~/.invoker',
        },
      ],
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, reason: 'deleting-orphans', removed: 1 });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(nonOrphan)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledOnce();
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain("-name '*.deleting.*'");
    expect(script).toContain('-mmin +30');
    expect(script).not.toContain('$INVOKER_HOME/worktrees');
    expect(script).not.toContain('$INVOKER_HOME/repos');
  });

  it('leaves dot-deleting entries that are not older than thirty minutes', async () => {
    const { root, home } = makeHome();
    const recentOrphan = join(home, 'runtime.deleting.123');
    mkdirSync(recentOrphan);
    age(recentOrphan, DELETING_ORPHAN_MIN_AGE_MS - 1_000);

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
    });

    expect(results).toEqual([
      expect.objectContaining({ ok: true, reason: 'deleting-orphans', removed: 0 }),
    ]);
    expect(existsSync(recentOrphan)).toBe(true);
  });

  it('builds a remote script guarded to the invoker home only', () => {
    const script = buildDeletingOrphanReclaimScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("rm -rf -- \"$entry\"");
    expect(script).not.toContain('cleanupRemoteInvokerHome');
  });
});

describe('reclaimAdminWorkDirs', () => {
  it('removes old immediate children of the two automation work roots', () => {
    const { root, home } = makeHome();
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const oldRequeue = join(requeueRoot, '1234');
    const oldBypass = join(bypassRoot, 'abcd');
    const recentRequeue = join(requeueRoot, '5678');
    mkdirSync(oldRequeue, { recursive: true });
    mkdirSync(oldBypass, { recursive: true });
    mkdirSync(recentRequeue, { recursive: true });
    age(oldRequeue, ADMIN_WORK_MIN_AGE_MS + 1_000);
    age(oldBypass, ADMIN_WORK_MIN_AGE_MS + 1_000);
    age(recentRequeue, ADMIN_WORK_MIN_AGE_MS - 1_000);

    const result = reclaimAdminWorkDirs({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(result).toMatchObject({ ok: true, reason: 'admin-work-dirs', removed: 2 });
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(oldBypass)).toBe(false);
    expect(existsSync(recentRequeue)).toBe(true);
  });

  it('leaves automation work children that are not older than forty-eight hours', () => {
    const { root, home } = makeHome();
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const recentRequeue = join(requeueRoot, '1234');
    const recentBypass = join(bypassRoot, 'abcd');
    mkdirSync(recentRequeue, { recursive: true });
    mkdirSync(recentBypass, { recursive: true });
    age(recentRequeue, ADMIN_WORK_MIN_AGE_MS - 1_000);
    age(recentBypass, ADMIN_WORK_MIN_AGE_MS - 1_000);

    const result = reclaimAdminWorkDirs({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(result).toMatchObject({ ok: true, reason: 'admin-work-dirs', removed: 0 });
    expect(existsSync(recentRequeue)).toBe(true);
    expect(existsSync(recentBypass)).toBe(true);
  });
});

describe('reclaimHourlySnapshots', () => {
  it('applies the exported hourly snapshot retention to the existing backup directory', () => {
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 5);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = reclaimHourlySnapshots({ invokerHome: home, userHome: root });

    expect(result).toMatchObject({ ok: true, reason: 'hourly-snapshots', removed: 3 });
    expect(hourlyBaseNames(backupDir)).toEqual([
      'invoker.db.hourly-auto-20260101-000003-000Z',
      'invoker.db.hourly-auto-20260101-000004-000Z',
    ]);
  });

  it('leaves hourly snapshots alone when the pile is within retention', () => {
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '3';

    const result = reclaimHourlySnapshots({ invokerHome: home, userHome: root });

    expect(result).toMatchObject({ ok: true, reason: 'hourly-snapshots', removed: 0 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims oversized known logs and matching UI trace logs to the kept tail', () => {
    const { root, home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const uiTrace = join(home, 'ui-task-graph-events.jsonl');
    const unrelated = join(home, 'worker.log');
    writeFileSync(invokerLog, '0123456789abcdefghijklmnopqrstuvwxyz');
    writeFileSync(uiTrace, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    writeBytes(unrelated, 36, 'u');

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 30,
      keepBytes: 10,
    });

    expect(result).toMatchObject({ ok: true, reason: 'known-logs', trimmed: 2 });
    expect(readFileSync(invokerLog, 'utf8')).toBe('qrstuvwxyz');
    expect(readFileSync(uiTrace, 'utf8')).toBe('0123456789');
    expect(statSync(unrelated).size).toBe(36);
  });

  it('leaves known logs alone while they are below the size threshold', () => {
    const { root, home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    writeFileSync(invokerLog, 'small');
    writeFileSync(guiLog, 'also-small');

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 30,
      keepBytes: 10,
    });

    expect(result).toMatchObject({ ok: true, reason: 'known-logs', trimmed: 0 });
    expect(readFileSync(invokerLog, 'utf8')).toBe('small');
    expect(readFileSync(guiLog, 'utf8')).toBe('also-small');
  });
});
