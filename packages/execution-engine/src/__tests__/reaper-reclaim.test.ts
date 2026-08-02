import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
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
  pruneHourlySnapshotsOnReaperSchedule,
  reclaimAutomationCheckoutWorkDirs,
  reclaimDeletingOrphans,
  trimInvokerLogs,
} from '../workers/reaper-reclaim.js';

const CONN = { host: 'h', user: 'u', sshKeyPath: '/k' };
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeInvokerHome(prefix = 'invoker-reaper-'): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, ageMs: number): void {
  const date = new Date(Date.now() - ageMs);
  utimesSync(path, date, date);
}

function runLocalBashScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`bash exited ${code}: ${stderr || stdout}`));
      }
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('reclaimDeletingOrphans', () => {
  it('removes stale dot-deleting entries locally and remotely while leaving recent and normal entries', async () => {
    const local = makeInvokerHome();
    const remote = makeInvokerHome();
    const oldAgeMs = 2 * 60 * 60 * 1000;
    const recentAgeMs = 5 * 60 * 1000;

    mkdirSync(join(local.home, 'merge-clones.deleting.123', 'child'), { recursive: true });
    mkdirSync(join(local.home, 'repos.deleting.456'), { recursive: true });
    mkdirSync(join(local.home, 'worktrees', 'keep'), { recursive: true });
    mkdirSync(join(remote.home, 'runtime.deleting.123'), { recursive: true });
    mkdirSync(join(remote.home, 'merge-launches.deleting.456'), { recursive: true });
    mkdirSync(join(remote.home, 'worktrees', 'keep'), { recursive: true });

    setAge(join(local.home, 'merge-clones.deleting.123'), oldAgeMs);
    setAge(join(local.home, 'repos.deleting.456'), recentAgeMs);
    setAge(join(local.home, 'worktrees'), oldAgeMs);
    setAge(join(remote.home, 'runtime.deleting.123'), oldAgeMs);
    setAge(join(remote.home, 'merge-launches.deleting.456'), recentAgeMs);
    setAge(join(remote.home, 'worktrees'), oldAgeMs);

    const results = await reclaimDeletingOrphans({
      invokerHome: local.home,
      userHome: local.root,
      remoteTargets: [{ name: 'remote-1', connection: CONN, remotePath: remote.home }],
      runRemoteScript: (_target, script) => runLocalBashScript(script),
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(existsSync(join(local.home, 'merge-clones.deleting.123'))).toBe(false);
    expect(existsSync(join(local.home, 'repos.deleting.456'))).toBe(true);
    expect(existsSync(join(local.home, 'worktrees', 'keep'))).toBe(true);
    expect(existsSync(join(remote.home, 'runtime.deleting.123'))).toBe(false);
    expect(existsSync(join(remote.home, 'merge-launches.deleting.456'))).toBe(true);
    expect(existsSync(join(remote.home, 'worktrees', 'keep'))).toBe(true);
  });
});

describe('reclaimAutomationCheckoutWorkDirs', () => {
  it('removes only old immediate children from the two automation checkout roots', () => {
    const { root, home } = makeInvokerHome();
    const oldAgeMs = 49 * 60 * 60 * 1000;
    const recentAgeMs = 2 * 60 * 60 * 1000;
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');

    mkdirSync(join(requeueRoot, 'old-checkout', 'repo'), { recursive: true });
    mkdirSync(join(requeueRoot, 'recent-checkout'), { recursive: true });
    mkdirSync(join(bypassRoot, 'old-checkout'), { recursive: true });
    mkdirSync(join(bypassRoot, 'recent-checkout'), { recursive: true });
    setAge(join(requeueRoot, 'old-checkout'), oldAgeMs);
    setAge(join(requeueRoot, 'recent-checkout'), recentAgeMs);
    setAge(join(bypassRoot, 'old-checkout'), oldAgeMs);
    setAge(join(bypassRoot, 'recent-checkout'), recentAgeMs);

    const result = reclaimAutomationCheckoutWorkDirs({ invokerHome: home, userHome: root });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(2);
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(join(requeueRoot, 'old-checkout'))).toBe(false);
    expect(existsSync(join(requeueRoot, 'recent-checkout'))).toBe(true);
    expect(existsSync(join(bypassRoot, 'old-checkout'))).toBe(false);
    expect(existsSync(join(bypassRoot, 'recent-checkout'))).toBe(true);
  });
});

describe('pruneHourlySnapshotsOnReaperSchedule', () => {
  it('uses the exported hourly retention and leaves retained or non-hourly snapshots alone', () => {
    const previousRetention = process.env.INVOKER_HOURLY_BACKUP_RETENTION;
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';
    try {
      const { home } = makeInvokerHome();
      const backupDir = join(home, 'db-backups');
      mkdirSync(backupDir, { recursive: true });
      const oldest = join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z');
      const middle = join(backupDir, 'invoker.db.hourly-auto-20260101-010000-000Z');
      const newest = join(backupDir, 'invoker.db.hourly-auto-20260101-020000-000Z');
      const manual = join(backupDir, 'invoker.db.before-delete-all-20260101-000000-000Z');
      for (const file of [oldest, middle, newest, manual]) {
        writeFileSync(file, 'snapshot');
      }

      const removed = pruneHourlySnapshotsOnReaperSchedule(home);

      expect(removed).toBe(1);
      expect(existsSync(oldest)).toBe(false);
      expect(existsSync(middle)).toBe(true);
      expect(existsSync(newest)).toBe(true);
      expect(existsSync(manual)).toBe(true);
    } finally {
      if (previousRetention === undefined) {
        delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
      } else {
        process.env.INVOKER_HOURLY_BACKUP_RETENTION = previousRetention;
      }
    }
  });
});

describe('trimInvokerLogs', () => {
  it('keeps only the tail of oversized known logs while leaving small and unmatched files untouched', () => {
    const { root, home } = makeInvokerHome();
    const large = Buffer.from('0123456789'.repeat(14));
    const trace = Buffer.from('abcdefghijklmnopqrstuvwxyz'.repeat(6));
    const small = 'small-log';
    const unmatched = Buffer.from('x'.repeat(140));
    const invokerLog = join(home, 'invoker.log');
    const guiLog = join(home, 'gui.log');
    const uiTraceLog = join(home, 'ui-task-graph-events.jsonl');
    const taskLog = join(home, 'task.log');
    writeFileSync(invokerLog, large);
    writeFileSync(guiLog, small);
    writeFileSync(uiTraceLog, trace);
    writeFileSync(taskLog, unmatched);

    const result = trimInvokerLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 100,
      keepBytes: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.trimmed).toBe(2);
    expect(statSync(invokerLog).size).toBe(20);
    expect(readFileSync(invokerLog, 'utf8')).toBe(large.subarray(large.length - 20).toString());
    expect(readFileSync(guiLog, 'utf8')).toBe(small);
    expect(statSync(uiTraceLog).size).toBe(20);
    expect(readFileSync(uiTraceLog, 'utf8')).toBe(trace.subarray(trace.length - 20).toString());
    expect(statSync(taskLog).size).toBe(140);
  });
});
