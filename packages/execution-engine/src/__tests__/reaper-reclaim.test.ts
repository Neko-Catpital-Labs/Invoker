import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  reclaimAutomationWorkItems,
  reclaimDeletingOrphans,
  reclaimHourlySnapshotOverflow,
  trimKnownInvokerLogs,
} from '../workers/reaper-reclaim.js';

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];
const originalHourlyRetention = process.env.INVOKER_HOURLY_BACKUP_RETENTION;

afterEach(() => {
  if (originalHourlyRetention === undefined) {
    delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  } else {
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = originalHourlyRetention;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempHome(): string {
  const root = join(tmpdir(), `invoker-reaper-${process.pid}-${Date.now()}-${tempDirs.length}`);
  mkdirSync(root, { recursive: true });
  tempDirs.push(root);
  return root;
}

function setAge(path: string, ageMs: number, nowMs: number): void {
  const when = new Date(nowMs - ageMs);
  utimesSync(path, when, when);
}

function runBash(script: string, home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', script], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

describe('reclaimDeletingOrphans', () => {
  it('removes only old dot-deleting entries locally and on configured remotes', async () => {
    const root = makeTempHome();
    const nowMs = Date.now();
    const localHome = join(root, '.invoker-local');
    const remoteHome = join(root, '.invoker-remote');
    mkdirSync(localHome, { recursive: true });
    mkdirSync(remoteHome, { recursive: true });

    const oldLocal = join(localHome, 'worktrees.deleting.1');
    const freshLocal = join(localHome, 'repos.deleting.2');
    const oldRemote = join(remoteHome, 'merge-clones.deleting.3');
    const freshRemote = join(remoteHome, 'runtime.deleting.4');
    mkdirSync(oldLocal);
    mkdirSync(freshLocal);
    mkdirSync(oldRemote);
    mkdirSync(freshRemote);
    mkdirSync(join(localHome, 'worktrees'));

    setAge(oldLocal, 31 * 60 * 1000, nowMs);
    setAge(freshLocal, 5 * 60 * 1000, nowMs);
    setAge(oldRemote, 31 * 60 * 1000, nowMs);
    setAge(freshRemote, 5 * 60 * 1000, nowMs);

    const remoteTargets: RemoteDiskTarget[] = [
      {
        name: 'remote-a',
        connection: { host: 'remote-a', user: 'invoker', sshKeyPath: '/tmp/key' },
        remotePath: remoteHome,
      },
    ];
    let remoteScript = '';

    const results = await reclaimDeletingOrphans({
      invokerHome: localHome,
      userHome: root,
      remoteTargets,
      nowMs,
      runRemoteScript: async (_target, script) => {
        remoteScript = script;
        return runBash(script, root);
      },
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(existsSync(oldLocal)).toBe(false);
    expect(existsSync(freshLocal)).toBe(true);
    expect(existsSync(oldRemote)).toBe(false);
    expect(existsSync(freshRemote)).toBe(true);
    expect(existsSync(join(localHome, 'worktrees'))).toBe(true);
    expect(remoteScript).toContain("-maxdepth 1 -mmin +30");
    expect(remoteScript).not.toContain('merge-launches');
    expect(remoteScript).not.toContain('pr-cron-work');
  });
});

describe('reclaimAutomationWorkItems', () => {
  it('removes old immediate automation work children and leaves recent children and parents', () => {
    const root = makeTempHome();
    const nowMs = Date.now();
    const home = join(root, '.invoker');
    const requeueParent = join(home, 'mergify-admin-requeue-work');
    const bypassParent = join(home, 'land-admin-bypass-work');
    mkdirSync(requeueParent, { recursive: true });
    mkdirSync(bypassParent, { recursive: true });

    const oldRequeue = join(requeueParent, '1234');
    const freshRequeue = join(requeueParent, '5678');
    const oldBypass = join(bypassParent, '9012');
    const freshBypass = join(bypassParent, '3456');
    mkdirSync(oldRequeue);
    mkdirSync(freshRequeue);
    mkdirSync(oldBypass);
    mkdirSync(freshBypass);

    setAge(oldRequeue, 49 * 60 * 60 * 1000, nowMs);
    setAge(freshRequeue, 2 * 60 * 60 * 1000, nowMs);
    setAge(oldBypass, 49 * 60 * 60 * 1000, nowMs);
    setAge(freshBypass, 2 * 60 * 60 * 1000, nowMs);

    const result = reclaimAutomationWorkItems({
      invokerHome: home,
      userHome: root,
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(2);
    expect(existsSync(requeueParent)).toBe(true);
    expect(existsSync(bypassParent)).toBe(true);
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(freshRequeue)).toBe(true);
    expect(existsSync(oldBypass)).toBe(false);
    expect(existsSync(freshBypass)).toBe(true);
  });
});

describe('reclaimHourlySnapshotOverflow', () => {
  it('applies the existing hourly snapshot retention and leaves retained snapshots', () => {
    const root = makeTempHome();
    const backupDir = join(root, '.invoker', 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    const old = join(backupDir, 'invoker.db.hourly-auto-20260701-000000-000Z');
    const middle = join(backupDir, 'invoker.db.hourly-auto-20260701-010000-000Z');
    const newest = join(backupDir, 'invoker.db.hourly-auto-20260701-020000-000Z');
    const manual = join(backupDir, 'invoker.db.before-delete-all-20260701-030000-000Z');
    writeFileSync(old, 'old');
    writeFileSync(`${old}-wal`, 'old-wal');
    writeFileSync(middle, 'middle');
    writeFileSync(newest, 'newest');
    writeFileSync(manual, 'manual');
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = reclaimHourlySnapshotOverflow({ backupDir });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}-wal`)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(manual)).toBe(true);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims known oversized logs and leaves small logs untouched', () => {
    const root = makeTempHome();
    const home = join(root, '.invoker');
    mkdirSync(home, { recursive: true });
    const largeLog = join(home, 'invoker.log');
    const smallLog = join(home, 'gui.log');
    const largeGlobLog = join(home, 'ui-task-graph-events.jsonl');
    const unrelated = join(home, 'other.log');
    writeFileSync(largeLog, '0123456789abcdef');
    writeFileSync(smallLog, 'small');
    writeFileSync(largeGlobLog, 'abcdefghijklmnop');
    writeFileSync(unrelated, '0123456789abcdef');

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 10,
      retainBytes: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.trimmed).toBe(24);
    expect(statSync(largeLog).size).toBe(4);
    expect(readFileSync(largeLog, 'utf8')).toBe('cdef');
    expect(readFileSync(smallLog, 'utf8')).toBe('small');
    expect(statSync(largeGlobLog).size).toBe(4);
    expect(readFileSync(largeGlobLog, 'utf8')).toBe('mnop');
    expect(readFileSync(unrelated, 'utf8')).toBe('0123456789abcdef');
  });
});
