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

import {
  AUTOMATION_CHECKOUT_WORK_DIRS,
  cleanupAutomationCheckoutWork,
  cleanupDeletingOrphans,
  pruneHourlySnapshotBackups,
  trimInvokerLogFiles,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];
const originalRetentionEnv = process.env.INVOKER_HOURLY_BACKUP_RETENTION;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalRetentionEnv === undefined) {
    delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  } else {
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = originalRetentionEnv;
  }
});

function makeHome(prefix: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function touch(path: string, ageMs: number, nowMs: number): void {
  const when = new Date(nowMs - ageMs);
  utimesSync(path, when, when);
}

describe('cleanupDeletingOrphans', () => {
  it('removes old local dot-deleting orphans and reaches configured remotes', async () => {
    const { root, home } = makeHome('reaper-orphans-');
    const nowMs = Date.now();
    const oldOrphan = join(home, 'worktrees.deleting.123');
    mkdirSync(oldOrphan, { recursive: true });
    writeFileSync(join(oldOrphan, 'payload.txt'), 'stale');
    touch(oldOrphan, 31 * 60 * 1000, nowMs);

    const freshOrphan = join(home, 'repos.deleting.456');
    mkdirSync(freshOrphan, { recursive: true });
    touch(freshOrphan, 10 * 60 * 1000, nowMs);

    const oldNonOrphan = join(home, 'worktrees-old');
    mkdirSync(oldNonOrphan, { recursive: true });
    touch(oldNonOrphan, 31 * 60 * 1000, nowMs);

    const remoteTarget: RemoteDiskTarget = {
      name: 'ci-a',
      remotePath: '~/.invoker',
      connection: { host: 'ci.example.com', user: 'runner', sshKeyPath: '/tmp/key' },
    };
    const runRemoteScript = vi.fn(async () => '__INVOKER_REAPER_REMOVED__=1\n');

    const results = await cleanupDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets: [remoteTarget],
      runRemoteScript,
    });

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
    expect(existsSync(oldNonOrphan)).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, removed: 1 });
    expect(results[1]).toMatchObject({ targetKey: 'ssh:ci-a ~/.invoker', ok: true, removed: 1 });
    expect(runRemoteScript).toHaveBeenCalledWith(remoteTarget, expect.stringContaining('*.deleting.*'));
    expect(runRemoteScript.mock.calls[0]?.[1]).not.toContain('remove_path "$INVOKER_HOME/worktrees"');
  });

  it('leaves recent dot-deleting entries alone', async () => {
    const { root, home } = makeHome('reaper-fresh-orphans-');
    const nowMs = Date.now();
    const freshOrphan = join(home, 'merge-clones.deleting.789');
    mkdirSync(freshOrphan, { recursive: true });
    touch(freshOrphan, 5 * 60 * 1000, nowMs);

    const results = await cleanupDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets: [],
    });

    expect(existsSync(freshOrphan)).toBe(true);
    expect(results[0]).toMatchObject({ ok: true, checked: 1, removed: 0 });
  });
});

describe('cleanupAutomationCheckoutWork', () => {
  it('removes only immediate automation checkout children older than forty-eight hours', () => {
    const { root, home } = makeHome('reaper-automation-');
    const nowMs = Date.now();

    for (const parentName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const parent = join(home, parentName);
      mkdirSync(parent, { recursive: true });
      const oldChild = join(parent, 'old-child');
      mkdirSync(join(oldChild, 'nested'), { recursive: true });
      touch(oldChild, 49 * 60 * 60 * 1000, nowMs);
      const freshChild = join(parent, 'fresh-child');
      mkdirSync(freshChild, { recursive: true });
      touch(freshChild, 2 * 60 * 60 * 1000, nowMs);
    }

    const result = cleanupAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result.errors).toEqual([]);
    expect(result.removed).toBe(2);
    for (const parentName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const parent = join(home, parentName);
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(join(parent, 'old-child'))).toBe(false);
      expect(existsSync(join(parent, 'fresh-child'))).toBe(true);
    }
  });

  it('leaves recent automation checkout children alone', () => {
    const { root, home } = makeHome('reaper-automation-fresh-');
    const nowMs = Date.now();
    const parent = join(home, 'mergify-admin-requeue-work');
    const freshChild = join(parent, 'recent');
    mkdirSync(freshChild, { recursive: true });
    touch(freshChild, 1 * 60 * 60 * 1000, nowMs);

    const result = cleanupAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result.removed).toBe(0);
    expect(existsSync(freshChild)).toBe(true);
  });
});

describe('pruneHourlySnapshotBackups', () => {
  it('calls the exported hourly retention helpers to prune excess hourly snapshots', async () => {
    const { root, home } = makeHome('reaper-snapshots-');
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';

    const oldSnapshot = 'invoker.db.hourly-auto-20260101-000000-000Z';
    const newSnapshot = 'invoker.db.hourly-auto-20260101-010000-000Z';
    writeFileSync(join(backupDir, oldSnapshot), 'old');
    writeFileSync(join(backupDir, `${oldSnapshot}-wal`), 'old-wal');
    writeFileSync(join(backupDir, `${oldSnapshot}-shm`), 'old-shm');
    writeFileSync(join(backupDir, newSnapshot), 'new');
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'), 'manual');

    const result = await pruneHourlySnapshotBackups({ invokerHome: home, userHome: root });

    expect(result.errors).toEqual([]);
    expect(result.removed).toBe(1);
    expect(result.retain).toBe(1);
    expect(existsSync(join(backupDir, oldSnapshot))).toBe(false);
    expect(existsSync(join(backupDir, `${oldSnapshot}-wal`))).toBe(false);
    expect(existsSync(join(backupDir, `${oldSnapshot}-shm`))).toBe(false);
    expect(existsSync(join(backupDir, newSnapshot))).toBe(true);
    expect(existsSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when they are within retention', async () => {
    const { root, home } = makeHome('reaper-snapshots-keep-');
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '3';

    const firstSnapshot = 'invoker.db.hourly-auto-20260101-000000-000Z';
    const secondSnapshot = 'invoker.db.hourly-auto-20260101-010000-000Z';
    writeFileSync(join(backupDir, firstSnapshot), 'first');
    writeFileSync(join(backupDir, secondSnapshot), 'second');

    const result = await pruneHourlySnapshotBackups({ invokerHome: home, userHome: root });

    expect(result.errors).toEqual([]);
    expect(result.removed).toBe(0);
    expect(existsSync(join(backupDir, firstSnapshot))).toBe(true);
    expect(existsSync(join(backupDir, secondSnapshot))).toBe(true);
  });
});

describe('trimInvokerLogFiles', () => {
  it('rewrites known large Invoker log files to their tail', () => {
    const { root, home } = makeHome('reaper-logs-');
    const fixtures = new Map([
      ['invoker.log', '0123456789abcdefghijklmnopqrstuvwxyz'],
      ['gui.log', 'abcdefghijklmnopqrstuvwxyz0123456789'],
      ['merge-trace.log', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
      ['ui-task-graph-events.jsonl', 'jsonl-line-0000\njsonl-line-1111\n'],
    ]);
    for (const [name, content] of fixtures) {
      writeFileSync(join(home, name), content);
    }

    const result = trimInvokerLogFiles({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 20,
      keepBytes: 8,
    });

    expect(result.errors).toEqual([]);
    expect(result.trimmed).toBe(4);
    for (const [name, content] of fixtures) {
      const path = join(home, name);
      expect(statSync(path).size).toBe(8);
      expect(readFileSync(path, 'utf8')).toBe(content.slice(-8));
    }
  });

  it('leaves small Invoker log files untouched', () => {
    const { root, home } = makeHome('reaper-logs-small-');
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    writeFileSync(invokerLog, 'small');
    writeFileSync(guiLog, 'also-small');

    const result = trimInvokerLogFiles({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 20,
      keepBytes: 8,
    });

    expect(result.trimmed).toBe(0);
    expect(readFileSync(invokerLog, 'utf8')).toBe('small');
    expect(readFileSync(guiLog, 'utf8')).toBe('also-small');
  });
});
