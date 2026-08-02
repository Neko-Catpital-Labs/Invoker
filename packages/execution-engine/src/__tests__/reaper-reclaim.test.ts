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
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_CHECKOUT_MAX_AGE_MS,
  buildDeletingOrphanReclaimScript,
  DELETING_ORPHAN_MIN_AGE_MS,
  pruneHourlySnapshotsForReaper,
  reclaimDeletingOrphans,
  reclaimStaleAutomationCheckouts,
  trimKnownInvokerLogs,
  type ReaperRemoteScriptRunner,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];
const originalHourlyRetention = process.env.INVOKER_HOURLY_BACKUP_RETENTION;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHourlyRetention === undefined) {
    delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  } else {
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = originalHourlyRetention;
  }
});

function makeHome(prefix: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function setAge(path: string, nowMs: number, ageMs: number): void {
  const date = new Date(nowMs - ageMs);
  utimesSync(path, date, date);
}

describe('reclaimDeletingOrphans', () => {
  it('removes old dot-deleting entries locally, leaves recent/non-matching entries, and uses the narrow remote script', async () => {
    const { root, home } = makeHome('invoker-reaper-orphans-');
    const nowMs = Date.now();

    const oldOrphan = join(home, 'merge-clones.deleting.123');
    const recentOrphan = join(home, 'repos.deleting.456');
    const oldNonMatch = join(home, 'merge-clones.deleted.789');
    mkdirSync(join(oldOrphan, 'payload'), { recursive: true });
    mkdirSync(join(recentOrphan, 'payload'), { recursive: true });
    mkdirSync(join(oldNonMatch, 'payload'), { recursive: true });
    setAge(oldOrphan, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 60_000);
    setAge(recentOrphan, nowMs, DELETING_ORPHAN_MIN_AGE_MS - 60_000);
    setAge(oldNonMatch, nowMs, DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'remote-a',
      connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
      remotePath: '~/.invoker',
    }];
    const remoteCalls: Array<{ target: RemoteDiskTarget; script: string }> = [];
    const runRemoteScript: ReaperRemoteScriptRunner = async (target, script) => {
      remoteCalls.push({ target, script });
      return '[reaper-reclaim] deleting-orphans removed=1';
    };

    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets,
      nowMs,
      runRemoteScript,
    });

    expect(results[0]).toMatchObject({ ok: true, removed: 1, reason: 'deleting-orphans' });
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(recentOrphan)).toBe(true);
    expect(existsSync(oldNonMatch)).toBe(true);

    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]?.target).toBe(remoteTargets[0]);
    expect(remoteCalls[0]?.script).toContain("name '*.deleting.*'");
    expect(remoteCalls[0]?.script).toContain('-mmin +30');
    expect(remoteCalls[0]?.script).not.toContain('remove_path');
    expect(remoteCalls[0]?.script).not.toContain('merge-launches');
  });

  it('builds a guarded orphan-only script', () => {
    const script = buildDeletingOrphanReclaimScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("name '*.deleting.*'");
    expect(script).not.toContain('runtime repos worktrees');
  });
});

describe('reclaimStaleAutomationCheckouts', () => {
  it('removes only old immediate children of the two automation checkout roots', () => {
    const { root, home } = makeHome('invoker-reaper-checkouts-');
    const nowMs = Date.now();

    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const otherRoot = join(home, 'worktrees');
    mkdirSync(requeueRoot, { recursive: true });
    mkdirSync(bypassRoot, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });

    const oldRequeue = join(requeueRoot, '5810');
    const recentRequeue = join(requeueRoot, '5811');
    const oldBypass = join(bypassRoot, '5920');
    const outsideNamedRoot = join(otherRoot, 'old-task');
    mkdirSync(join(oldRequeue, 'payload'), { recursive: true });
    mkdirSync(join(recentRequeue, 'payload'), { recursive: true });
    mkdirSync(join(oldBypass, 'payload'), { recursive: true });
    mkdirSync(join(outsideNamedRoot, 'payload'), { recursive: true });
    setAge(oldRequeue, nowMs, AUTOMATION_CHECKOUT_MAX_AGE_MS + 60_000);
    setAge(recentRequeue, nowMs, AUTOMATION_CHECKOUT_MAX_AGE_MS - 60_000);
    setAge(oldBypass, nowMs, AUTOMATION_CHECKOUT_MAX_AGE_MS + 60_000);
    setAge(outsideNamedRoot, nowMs, AUTOMATION_CHECKOUT_MAX_AGE_MS + 60_000);

    const result = reclaimStaleAutomationCheckouts({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, removed: 2, reason: 'automation-checkouts' });
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(oldBypass)).toBe(false);
    expect(existsSync(recentRequeue)).toBe(true);
    expect(existsSync(outsideNamedRoot)).toBe(true);
  });
});

describe('pruneHourlySnapshotsForReaper', () => {
  it('applies the existing hourly retention and leaves retained/manual snapshots alone', () => {
    const { home } = makeHome('invoker-reaper-snapshots-');
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const oldest = 'invoker.db.hourly-auto-20260730-000000-000Z';
    const retainedA = 'invoker.db.hourly-auto-20260731-000000-000Z';
    const retainedB = 'invoker.db.hourly-auto-20260801-000000-000Z';
    const manual = 'invoker.db.before-delete-all-20260729-000000-000Z';
    for (const name of [oldest, retainedA, retainedB, manual]) {
      writeFileSync(join(backupDir, name), name);
    }

    const result = pruneHourlySnapshotsForReaper({ backupDir });

    expect(result).toMatchObject({ ok: true, removed: 1, reason: 'hourly-snapshots' });
    expect(existsSync(join(backupDir, oldest))).toBe(false);
    expect(existsSync(join(backupDir, retainedA))).toBe(true);
    expect(existsSync(join(backupDir, retainedB))).toBe(true);
    expect(existsSync(join(backupDir, manual))).toBe(true);
  });
});

describe('trimKnownInvokerLogs', () => {
  it('trims oversized known logs and leaves small or unknown logs alone', () => {
    const { root, home } = makeHome('invoker-reaper-logs-');
    const tail = Buffer.from('0123456789abcdefghij');
    const large = Buffer.concat([Buffer.alloc(100, 'x'), tail]);
    const small = Buffer.from('small-log');
    const unknownLarge = Buffer.concat([Buffer.alloc(100, 'u'), tail]);

    writeFileSync(join(home, 'invoker.log'), large);
    writeFileSync(join(home, 'merge-trace.log'), large);
    writeFileSync(join(home, 'gui.log'), small);
    writeFileSync(join(home, 'random.log'), unknownLarge);

    const result = trimKnownInvokerLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 100,
      keepBytes: tail.length,
    });

    expect(result).toMatchObject({ ok: true, trimmed: 2, reason: 'known-log-trim' });
    expect(statSync(join(home, 'invoker.log')).size).toBe(tail.length);
    expect(readFileSync(join(home, 'invoker.log'))).toEqual(tail);
    expect(statSync(join(home, 'merge-trace.log')).size).toBe(tail.length);
    expect(readFileSync(join(home, 'merge-trace.log'))).toEqual(tail);
    expect(readFileSync(join(home, 'gui.log'))).toEqual(small);
    expect(readFileSync(join(home, 'random.log'))).toEqual(unknownLarge);
  });
});
