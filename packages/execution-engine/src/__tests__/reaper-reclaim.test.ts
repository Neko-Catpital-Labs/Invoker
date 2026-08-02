import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_CHECKOUT_WORK_DIRS,
  AUTOMATION_CHECKOUT_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  reclaimDeletingOrphans,
  reclaimStaleAutomationCheckoutWork,
  pruneHourlySnapshotRetention,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  tempDirs.push(root);
  return { root, home };
}

function setAge(path: string, ageMs: number, nowMs: number): void {
  const at = new Date(nowMs - ageMs);
  utimesSync(path, at, at);
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

async function runBash(_target: RemoteDiskTarget, script: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync('bash', ['-c', script], { timeout: 5000 });
  return `${stdout}${stderr}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reclaimDeletingOrphans', () => {
  it('removes local and configured remote dot-deleting entries older than thirty minutes', async () => {
    const nowMs = Date.now();
    const { root, home } = makeHome();
    const remote = makeHome();
    const oldLocal = join(home, 'worktrees.deleting.123');
    const recentLocal = join(home, 'repos.deleting.456');
    const oldRemote = join(remote.home, 'merge-clones.deleting.789');
    const recentRemote = join(remote.home, 'runtime.deleting.999');
    const oldNonMatch = join(home, 'ordinary-old-dir');
    for (const dir of [oldLocal, recentLocal, oldRemote, recentRemote, oldNonMatch]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'file.txt'), 'x');
    }
    setAge(oldLocal, DELETING_ORPHAN_MIN_AGE_MS + 10 * 60 * 1000, nowMs);
    setAge(oldRemote, DELETING_ORPHAN_MIN_AGE_MS + 10 * 60 * 1000, nowMs);
    setAge(oldNonMatch, DELETING_ORPHAN_MIN_AGE_MS + 10 * 60 * 1000, nowMs);
    setAge(recentLocal, 5 * 60 * 1000, nowMs);
    setAge(recentRemote, 5 * 60 * 1000, nowMs);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'remote-1',
      connection: { host: 'example.invalid', user: 'invoker', sshKeyPath: '/tmp/key' },
      remotePath: remote.home,
    }];

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets,
      nowMs,
      runRemoteScript: runBash,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(existsSync(oldLocal)).toBe(false);
    expect(existsSync(oldRemote)).toBe(false);
    expect(existsSync(recentLocal)).toBe(true);
    expect(existsSync(recentRemote)).toBe(true);
    expect(existsSync(oldNonMatch)).toBe(true);
  });

  it('leaves dot-deleting entries alone when they are too recent', async () => {
    const nowMs = Date.now();
    const { root, home } = makeHome();
    const recent = join(home, 'worktrees.deleting.recent');
    mkdirSync(recent, { recursive: true });
    writeFileSync(join(recent, 'file.txt'), 'x');
    setAge(recent, 5 * 60 * 1000, nowMs);

    const results = await reclaimDeletingOrphans({ invokerHome: home, userHome: root, nowMs });

    expect(results).toEqual([expect.objectContaining({ ok: true, removed: 0 })]);
    expect(existsSync(recent)).toBe(true);
  });
});

describe('reclaimStaleAutomationCheckoutWork', () => {
  it('removes immediate checkout work children older than forty-eight hours', () => {
    const nowMs = Date.now();
    const { root, home } = makeHome();
    const oldRequeue = join(home, AUTOMATION_CHECKOUT_WORK_DIRS[0], '123');
    const recentRequeue = join(home, AUTOMATION_CHECKOUT_WORK_DIRS[0], '456');
    const oldBypass = join(home, AUTOMATION_CHECKOUT_WORK_DIRS[1], 'stack-a');
    for (const dir of [oldRequeue, recentRequeue, oldBypass]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'file.txt'), 'x');
    }
    setAge(oldRequeue, AUTOMATION_CHECKOUT_MIN_AGE_MS + 60 * 60 * 1000, nowMs);
    setAge(oldBypass, AUTOMATION_CHECKOUT_MIN_AGE_MS + 60 * 60 * 1000, nowMs);
    setAge(recentRequeue, 60 * 60 * 1000, nowMs);

    const result = reclaimStaleAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, removed: 2 });
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(oldBypass)).toBe(false);
    expect(existsSync(recentRequeue)).toBe(true);
    for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
      expect(existsSync(join(home, dirName))).toBe(true);
    }
  });

  it('leaves checkout work children alone when they are too recent', () => {
    const nowMs = Date.now();
    const { root, home } = makeHome();
    const recent = join(home, AUTOMATION_CHECKOUT_WORK_DIRS[0], 'recent');
    mkdirSync(recent, { recursive: true });
    writeFileSync(join(recent, 'file.txt'), 'x');
    setAge(recent, 60 * 60 * 1000, nowMs);

    const result = reclaimStaleAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(recent)).toBe(true);
  });
});

describe('pruneHourlySnapshotRetention', () => {
  it('prunes hourly snapshots using the configured retention limit', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 3);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = pruneHourlySnapshotRetention({ invokerHome: home });

    expect(result).toMatchObject({ ok: true, removed: 1 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000002-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when they are within the retention limit', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '3';

    const result = pruneHourlySnapshotRetention({ invokerHome: home });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims known large Invoker logs and UI trace logs to the requested tail size', () => {
    const { root, home } = makeHome();
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const uiTrace = join(home, 'ui-task-graph-events.jsonl');
    const unrelated = join(home, 'agent-session.jsonl');
    const large = Buffer.from('x'.repeat(120));
    for (const path of [invokerLog, guiLog, uiTrace, unrelated]) {
      writeFileSync(path, large);
    }

    const result = trimKnownInvokerLogs({ invokerHome: home, userHome: root, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ ok: true, trimmed: 3 });
    for (const path of [invokerLog, guiLog, uiTrace]) {
      expect(statSync(path).size).toBe(20);
      expect(readFileSync(path)).toEqual(large.subarray(-20));
    }
    expect(statSync(unrelated).size).toBe(120);
  });

  it('leaves known Invoker logs alone when they are below the size threshold', () => {
    const { root, home } = makeHome();
    const logPath = join(home, 'gui.log');
    const content = Buffer.from('small-log');
    writeFileSync(logPath, content);

    const result = trimKnownInvokerLogs({ invokerHome: home, userHome: root, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ ok: true, trimmed: 0 });
    expect(readFileSync(logPath)).toEqual(content);
  });
});
