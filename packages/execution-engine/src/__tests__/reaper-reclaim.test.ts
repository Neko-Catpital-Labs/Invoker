import {
  existsSync,
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
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';

import {
  REAPER_AUTOMATION_WORK_DIRS,
  REAPER_AUTOMATION_WORK_MIN_AGE_MS,
  REAPER_DELETING_ORPHAN_MIN_AGE_MS,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshots,
  trimInvokerLogFiles,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const NOW_MS = Date.UTC(2026, 7, 2, 12, 0, 0);

function tempHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, ageMs: number): void {
  const when = new Date(NOW_MS - ageMs);
  utimesSync(path, when, when);
}

function mkdirWithFile(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'file.txt'), 'x');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reclaimDeletingOrphans', () => {
  it('removes only old dot-deleting entries and also runs every configured remote target', async () => {
    const { root, home } = tempHome();
    const oldOrphan = join(home, 'worktrees.deleting.123');
    const freshOrphan = join(home, 'repos.deleting.456');
    const oldNonMatch = join(home, 'worktrees.deleted.789');
    mkdirWithFile(oldOrphan);
    mkdirWithFile(freshOrphan);
    mkdirWithFile(oldNonMatch);
    setAge(oldOrphan, REAPER_DELETING_ORPHAN_MIN_AGE_MS + 60_000);
    setAge(freshOrphan, 60_000);
    setAge(oldNonMatch, REAPER_DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const runRemoteScript = vi.fn(async () =>
      '[reaper-reclaim] deleting-orphans removed=1 home=/home/invoker/.invoker\n',
    );

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
      remoteTargets: [
        {
          name: 'worker-a',
          remotePath: '~/.invoker',
          connection: { sshKeyPath: '/tmp/key', user: 'invoker', host: 'worker-a' },
        },
      ],
      runRemoteScript,
    });

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
    expect(existsSync(oldNonMatch)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain("-name '*.deleting.*'");
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain('-mmin +30');
    expect(results.map((r) => [r.targetKey, r.ok, r.reason, r.removed])).toEqual([
      [`local ${home}`, true, 'reclaimed', 1],
      ['ssh:worker-a ~/.invoker', true, 'reclaimed', 1],
    ]);
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes old immediate automation-work children while preserving parents and fresh children', () => {
    const { root, home } = tempHome();
    for (const dirName of REAPER_AUTOMATION_WORK_DIRS) {
      const dir = join(home, dirName);
      const oldChild = join(dir, 'old-item');
      const freshChild = join(dir, 'fresh-item');
      mkdirWithFile(oldChild);
      mkdirWithFile(freshChild);
      setAge(oldChild, REAPER_AUTOMATION_WORK_MIN_AGE_MS + 60_000);
      setAge(freshChild, 60_000);
    }

    const result = reclaimAutomationCheckoutWork({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('reclaimed');
    expect(result.removed).toBe(2);
    for (const dirName of REAPER_AUTOMATION_WORK_DIRS) {
      const dir = join(home, dirName);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(['fresh-item']);
    }
  });
});

describe('reclaimHourlySnapshots', () => {
  it('applies existing hourly retention pruning and leaves retained/non-hourly snapshots alone', () => {
    const { home } = tempHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    const oldHourly = 'invoker.db.hourly-auto-20260101-000000-000Z';
    const retainedHourly = 'invoker.db.hourly-auto-20260101-010000-000Z';
    const manual = 'invoker.db.before-delete-all-20260101-020000-000Z';
    for (const name of [oldHourly, retainedHourly, manual]) {
      writeFileSync(join(backupDir, name), name);
    }
    writeFileSync(join(backupDir, `${oldHourly}-wal`), 'wal');
    writeFileSync(join(backupDir, `${oldHourly}-shm`), 'shm');

    const previous = process.env.INVOKER_HOURLY_BACKUP_RETENTION;
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';
    try {
      const result = reclaimHourlySnapshots({
        backupDir,
        hourlySnapshotRetention,
        pruneHourlySnapshots,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe('reclaimed');
      expect(result.removed).toBe(1);
      expect(existsSync(join(backupDir, oldHourly))).toBe(false);
      expect(existsSync(join(backupDir, `${oldHourly}-wal`))).toBe(false);
      expect(existsSync(join(backupDir, `${oldHourly}-shm`))).toBe(false);
      expect(existsSync(join(backupDir, retainedHourly))).toBe(true);
      expect(existsSync(join(backupDir, manual))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
      } else {
        process.env.INVOKER_HOURLY_BACKUP_RETENTION = previous;
      }
    }
  });
});

describe('trimInvokerLogFiles', () => {
  it('trims only oversized known log files and task-output full-log glob matches', () => {
    const { root, home } = tempHome();
    const taskLogDir = join(home, 'task-output', 'full');
    mkdirSync(taskLogDir, { recursive: true });
    const taskLog = join(taskLogDir, `${'a'.repeat(64)}.log`);
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const unrelatedLog = join(home, 'unrelated.log');
    const invokerLarge = `${'i'.repeat(110)}invoker-tail-1234567`;
    const taskLarge = `${'t'.repeat(115)}task-output-tail-123`;
    const small = 'small-log';
    const unrelatedLarge = 'u'.repeat(130);
    writeFileSync(invokerLog, invokerLarge);
    writeFileSync(taskLog, taskLarge);
    writeFileSync(guiLog, small);
    writeFileSync(unrelatedLog, unrelatedLarge);

    const result = trimInvokerLogFiles({
      invokerHome: home,
      userHome: root,
      maxBytes: 100,
      keepBytes: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('reclaimed');
    expect(result.trimmed).toBe(2);
    expect(readFileSync(invokerLog, 'utf8')).toBe(invokerLarge.slice(-20));
    expect(readFileSync(taskLog, 'utf8')).toBe(taskLarge.slice(-20));
    expect(readFileSync(guiLog, 'utf8')).toBe(small);
    expect(statSync(unrelatedLog).size).toBe(unrelatedLarge.length);
  });
});
