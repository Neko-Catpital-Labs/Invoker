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

import {
  AUTOMATION_CHECKOUT_MIN_AGE_MS,
  DELETING_ORPHAN_MIN_AGE_MS,
  reapDeletingOrphans,
  reapStaleAutomationCheckouts,
  pruneInvokerHourlySnapshots,
  trimLargeInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];
const NOW_MS = Date.UTC(2026, 7, 2, 12, 0, 0);

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function ageEntry(path: string, ageMs: number): void {
  const at = new Date(NOW_MS - ageMs);
  utimesSync(path, at, at);
}

function seedHourly(backupDir: string, count: number): void {
  mkdirSync(backupDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(backupDir, `invoker.db.hourly-auto-20260101-${String(i).padStart(6, '0')}-000Z`),
      `main-${i}`,
    );
  }
}

function hourlyBaseNames(backupDir: string): string[] {
  return readdirSync(backupDir).filter(
    (n) => n.startsWith('invoker.db.hourly-auto-') && !n.endsWith('-wal') && !n.endsWith('-shm'),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reapDeletingOrphans', () => {
  it('removes only old dot-deleting entries and reaches configured remotes', async () => {
    const { root, home } = makeHome();
    const oldDeleting = join(home, 'merge-clones.deleting.123');
    const recentDeleting = join(home, 'worktrees.deleting.456');
    const oldNonDeleting = join(home, 'merge-clones-old');
    mkdirSync(join(oldDeleting, 'stale'), { recursive: true });
    mkdirSync(recentDeleting, { recursive: true });
    mkdirSync(oldNonDeleting, { recursive: true });
    ageEntry(oldDeleting, DELETING_ORPHAN_MIN_AGE_MS + 60_000);
    ageEntry(recentDeleting, DELETING_ORPHAN_MIN_AGE_MS - 60_000);
    ageEntry(oldNonDeleting, DELETING_ORPHAN_MIN_AGE_MS + 60_000);

    const target: RemoteDiskTarget = {
      name: 'remote-a',
      remotePath: '~/.invoker',
      connection: { sshKeyPath: '/tmp/key', user: 'invoker', host: 'remote.example' },
    };
    const runRemoteScript = vi.fn(async () => 'remote ok');

    const result = await reapDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs: NOW_MS,
      remoteTargets: [target],
      runRemoteScript,
    });

    expect(result.local.removed).toBe(1);
    expect(existsSync(oldDeleting)).toBe(false);
    expect(existsSync(recentDeleting)).toBe(true);
    expect(existsSync(oldNonDeleting)).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledWith(target, expect.stringContaining("-mmin +30"));
    const script = runRemoteScript.mock.calls[0]?.[1] ?? '';
    expect(script).toContain("*'.deleting.'*");
    expect(script).not.toContain('$INVOKER_HOME/runtime');
    expect(script).not.toContain('$INVOKER_HOME/repos');
    expect(result.remotes).toEqual([
      expect.objectContaining({ targetKey: 'ssh:remote-a ~/.invoker', ok: true }),
    ]);
  });

  it('leaves recent dot-deleting entries alone', async () => {
    const { root, home } = makeHome();
    const recentDeleting = join(home, 'repos.deleting.123');
    mkdirSync(recentDeleting, { recursive: true });
    ageEntry(recentDeleting, DELETING_ORPHAN_MIN_AGE_MS - 60_000);

    const result = await reapDeletingOrphans({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(result.local.removed).toBe(0);
    expect(existsSync(recentDeleting)).toBe(true);
  });
});

describe('reapStaleAutomationCheckouts', () => {
  it('removes stale immediate children from both automation checkout roots', () => {
    const { root, home } = makeHome();
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const oldRequeue = join(requeueRoot, 'wf-old');
    const oldBypass = join(bypassRoot, 'wf-old');
    const recentRequeue = join(requeueRoot, 'wf-recent');
    mkdirSync(oldRequeue, { recursive: true });
    mkdirSync(oldBypass, { recursive: true });
    mkdirSync(recentRequeue, { recursive: true });
    ageEntry(oldRequeue, AUTOMATION_CHECKOUT_MIN_AGE_MS + 60_000);
    ageEntry(oldBypass, AUTOMATION_CHECKOUT_MIN_AGE_MS + 60_000);
    ageEntry(recentRequeue, AUTOMATION_CHECKOUT_MIN_AGE_MS - 60_000);

    const result = reapStaleAutomationCheckouts({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(result.removed).toBe(2);
    expect(existsSync(requeueRoot)).toBe(true);
    expect(existsSync(bypassRoot)).toBe(true);
    expect(existsSync(oldRequeue)).toBe(false);
    expect(existsSync(oldBypass)).toBe(false);
    expect(existsSync(recentRequeue)).toBe(true);
  });

  it('leaves recent automation checkout children alone', () => {
    const { root, home } = makeHome();
    const requeueRoot = join(home, 'mergify-admin-requeue-work');
    const bypassRoot = join(home, 'land-admin-bypass-work');
    const recentRequeue = join(requeueRoot, 'wf-recent');
    const recentBypass = join(bypassRoot, 'wf-recent');
    mkdirSync(recentRequeue, { recursive: true });
    mkdirSync(recentBypass, { recursive: true });
    ageEntry(recentRequeue, AUTOMATION_CHECKOUT_MIN_AGE_MS - 60_000);
    ageEntry(recentBypass, AUTOMATION_CHECKOUT_MIN_AGE_MS - 60_000);

    const result = reapStaleAutomationCheckouts({ invokerHome: home, userHome: root, nowMs: NOW_MS });

    expect(result.removed).toBe(0);
    expect(existsSync(recentRequeue)).toBe(true);
    expect(existsSync(recentBypass)).toBe(true);
  });
});

describe('pruneInvokerHourlySnapshots', () => {
  it('prunes hourly snapshots beyond the exported retention setting', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    const result = pruneInvokerHourlySnapshots(home);

    expect(result).toEqual({ backupDir, retain: 2, removed: 2 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000000-000Z'))).toBe(false);
    expect(existsSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000003-000Z'))).toBe(true);
  });

  it('leaves hourly snapshots alone when they are under the retention setting', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '5';

    const result = pruneInvokerHourlySnapshots(home);

    expect(result.removed).toBe(0);
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('trimLargeInvokerLogs', () => {
  it('trims large direct and globbed known log files to their tail', () => {
    const { root, home } = makeHome();
    const directLog = join(home, 'invoker.log');
    const globbedLog = join(home, 'task-output', 'full', 'task.log');
    mkdirSync(join(home, 'task-output', 'full'), { recursive: true });
    const directContent = `direct-${'a'.repeat(120)}-tail`;
    const globbedContent = `globbed-${'b'.repeat(120)}-tail`;
    writeFileSync(directLog, directContent);
    writeFileSync(globbedLog, globbedContent);

    const result = trimLargeInvokerLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 100,
      keepBytes: 20,
    });

    expect(result.trimmed).toBe(2);
    expect(statSync(directLog).size).toBe(20);
    expect(statSync(globbedLog).size).toBe(20);
    expect(readFileSync(directLog, 'utf8')).toBe(directContent.slice(-20));
    expect(readFileSync(globbedLog, 'utf8')).toBe(globbedContent.slice(-20));
  });

  it('leaves small known log files alone', () => {
    const { root, home } = makeHome();
    const smallLog = join(home, 'gui.log');
    writeFileSync(smallLog, 'small-log');

    const result = trimLargeInvokerLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 100,
      keepBytes: 20,
    });

    expect(result.trimmed).toBe(0);
    expect(readFileSync(smallLog, 'utf8')).toBe('small-log');
  });
});
