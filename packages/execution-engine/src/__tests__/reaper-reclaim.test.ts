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
  AUTOMATION_CHECKOUT_WORK_DIRS,
  AUTOMATION_WORK_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshotBacklog,
  resolveKnownInvokerLogPaths,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return home;
}

function agePath(path: string, ageMs: number, nowMs: number): void {
  const when = new Date(nowMs - ageMs);
  utimesSync(path, when, when);
}

function writeHourly(backupDir: string, suffix: string): string {
  mkdirSync(backupDir, { recursive: true });
  const path = join(backupDir, `invoker.db.hourly-auto-20260101-${suffix}-000Z`);
  writeFileSync(path, suffix);
  return path;
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
    const home = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const old = join(home, 'worktrees.deleting.123');
    const unrelated = join(home, 'worktrees-old');
    mkdirSync(old);
    mkdirSync(unrelated);
    agePath(old, DELETING_ORPHAN_MIN_AGE_MS + 1_000, nowMs);
    agePath(unrelated, DELETING_ORPHAN_MIN_AGE_MS + 1_000, nowMs);

    const result = await reclaimDeletingOrphans({ invokerHome: home, nowMs });

    expect(result.removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('leaves dot-deleting entries newer than thirty minutes and reaches remotes', async () => {
    const home = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const recent = join(home, 'repos.deleting.456');
    mkdirSync(recent);
    agePath(recent, DELETING_ORPHAN_MIN_AGE_MS - 1_000, nowMs);
    const target: RemoteDiskTarget = {
      name: 'remote-a',
      connection: { host: '203.0.113.10', user: 'invoker', sshKeyPath: '/tmp/test-key' },
      remotePath: '~/.invoker',
    };
    const runRemoteScript = vi.fn(async () => 'remote-ok');

    const result = await reclaimDeletingOrphans({
      invokerHome: home,
      remoteTargets: [target],
      nowMs,
      runRemoteScript,
    });

    expect(result.removed).toBe(0);
    expect(existsSync(recent)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0]?.[1]).toContain("-name '*.deleting.*' -mmin +30");
    expect(result.remoteResults).toEqual([{
      targetKey: 'ssh:remote-a ~/.invoker',
      ok: true,
      detail: 'remote-ok',
    }]);
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes immediate checkout-work children older than forty-eight hours', () => {
    const home = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (const dir of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const parent = join(home, dir);
      const old = join(parent, 'old-item');
      mkdirSync(old, { recursive: true });
      agePath(old, AUTOMATION_WORK_MIN_AGE_MS + 1_000, nowMs);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, nowMs });

    expect(result.removed).toBe(AUTOMATION_CHECKOUT_WORK_DIRS.length);
    for (const dir of AUTOMATION_CHECKOUT_WORK_DIRS) {
      expect(existsSync(join(home, dir))).toBe(true);
      expect(existsSync(join(home, dir, 'old-item'))).toBe(false);
    }
  });

  it('leaves checkout-work children newer than forty-eight hours', () => {
    const home = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (const dir of AUTOMATION_CHECKOUT_WORK_DIRS) {
      const parent = join(home, dir);
      const recent = join(parent, 'recent-item');
      mkdirSync(recent, { recursive: true });
      agePath(recent, AUTOMATION_WORK_MIN_AGE_MS - 1_000, nowMs);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, nowMs });

    expect(result.removed).toBe(0);
    for (const dir of AUTOMATION_CHECKOUT_WORK_DIRS) {
      expect(existsSync(join(home, dir, 'recent-item'))).toBe(true);
    }
  });
});

describe('reclaimHourlySnapshotBacklog', () => {
  it('prunes hourly snapshots beyond the exported retention resolver limit', () => {
    const home = makeHome();
    const backupDir = join(home, 'db-backups');
    const oldest = writeHourly(backupDir, '000000');
    const newest = writeHourly(backupDir, '000001');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';

    const result = reclaimHourlySnapshotBacklog({ invokerHome: home });

    expect(result.removed).toBe(1);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(hourlyBaseNames(backupDir)).toHaveLength(1);
  });

  it('leaves hourly snapshots within the exported retention resolver limit', () => {
    const home = makeHome();
    const backupDir = join(home, 'db-backups');
    const only = writeHourly(backupDir, '000000');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';

    const result = reclaimHourlySnapshotBacklog({ invokerHome: home });

    expect(result.removed).toBe(0);
    expect(existsSync(only)).toBe(true);
    expect(hourlyBaseNames(backupDir)).toHaveLength(1);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims known log files to their retained tail once over the limit', () => {
    const home = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const uiLog = join(home, 'ui-task-graph-events.jsonl');
    writeFileSync(invokerLog, '0123456789abcdef');
    writeFileSync(uiLog, 'abcdefghijklmnop');

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      maxBytes: 10,
      retainBytes: 4,
    });

    expect(result.trimmed).toBe(2);
    expect(readFileSync(invokerLog, 'utf8')).toBe('cdef');
    expect(readFileSync(uiLog, 'utf8')).toBe('mnop');
    expect(statSync(invokerLog).size).toBe(4);
    expect(resolveKnownInvokerLogPaths(home)).toContain(uiLog);
  });

  it('leaves known log files below the limit untouched', () => {
    const home = makeHome();
    const guiLog = join(home, 'gui.log');
    const unrelated = join(home, 'not-a-known-large-log.jsonl');
    writeFileSync(guiLog, 'small');
    writeFileSync(unrelated, '0123456789abcdef');

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      maxBytes: 10,
      retainBytes: 4,
    });

    expect(result.trimmed).toBe(0);
    expect(readFileSync(guiLog, 'utf8')).toBe('small');
    expect(readFileSync(unrelated, 'utf8')).toBe('0123456789abcdef');
  });
});
