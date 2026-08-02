import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDeletingOrphanReclaimScript,
  pruneHourlySnapshotsOnReaperSchedule,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  trimInvokerLogs,
} from '../workers/reaper-reclaim.js';
import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

const tempDirs: string[] = [];

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function age(path: string, ageMs: number, nowMs: number): void {
  const when = new Date(nowMs - ageMs);
  utimesSync(path, when, when);
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
});

describe('reclaimDeletingOrphans', () => {
  it('removes only dot-deleting entries older than thirty minutes and reaches remotes', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    mkdirSync(join(home, 'worktrees.deleting.123'), { recursive: true });
    writeFileSync(join(home, 'worktrees.deleting.123', 'payload'), 'old');
    mkdirSync(join(home, 'repos.deleting.456'), { recursive: true });
    writeFileSync(join(home, 'repos.deleting.456', 'payload'), 'recent');
    mkdirSync(join(home, 'worktrees', 'keep'), { recursive: true });
    age(join(home, 'worktrees.deleting.123'), 31 * 60 * 1000, nowMs);
    age(join(home, 'repos.deleting.456'), 29 * 60 * 1000, nowMs);

    const remoteTargets: RemoteDiskTarget[] = [{
      name: 'box',
      remotePath: '~/.invoker',
      connection: { host: 'example.test', user: 'invoker', sshKeyPath: '/tmp/key' },
    }];
    const runRemoteScript = vi.fn(async () => 'removed=1');

    const result = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets,
      runRemoteScript,
      nowMs,
    });

    expect(result.local.removed).toBe(1);
    expect(existsSync(join(home, 'worktrees.deleting.123'))).toBe(false);
    expect(existsSync(join(home, 'repos.deleting.456'))).toBe(true);
    expect(existsSync(join(home, 'worktrees', 'keep'))).toBe(true);
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(runRemoteScript.mock.calls[0][0]).toBe(remoteTargets[0]);
    expect(runRemoteScript.mock.calls[0][1]).toContain("*.deleting.*' -mmin +30");
    expect(result.remotes[0]).toMatchObject({ ok: true, reason: 'deleting-orphans' });
  });

  it('leaves dot-deleting entries newer than thirty minutes untouched', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    mkdirSync(join(home, 'merge-clones.deleting.123'), { recursive: true });
    age(join(home, 'merge-clones.deleting.123'), 10 * 60 * 1000, nowMs);

    const result = await reclaimDeletingOrphans({ invokerHome: home, userHome: root, nowMs });

    expect(result.local).toMatchObject({ removed: 0, skipped: 1 });
    expect(existsSync(join(home, 'merge-clones.deleting.123'))).toBe(true);
  });

  it('builds a remote script that only reaps aged dot-deleting entries', () => {
    const script = buildDeletingOrphanReclaimScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("*.deleting.*");
    expect(script).toContain('-mmin +30');
    expect(script).not.toContain('worktrees');
    expect(script).not.toContain('merge-clones');
    expect(script).not.toContain('repos');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes immediate checkout-work children older than forty-eight hours', () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    for (const parent of ['mergify-admin-requeue-work', 'land-admin-bypass-work']) {
      mkdirSync(join(home, parent, 'old', 'nested'), { recursive: true });
      writeFileSync(join(home, parent, 'old', 'nested', 'payload'), 'old');
      mkdirSync(join(home, parent, 'recent'), { recursive: true });
      age(join(home, parent, 'old'), 49 * 60 * 60 * 1000, nowMs);
      age(join(home, parent, 'recent'), 47 * 60 * 60 * 1000, nowMs);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result.removed).toBe(2);
    for (const parent of ['mergify-admin-requeue-work', 'land-admin-bypass-work']) {
      expect(existsSync(join(home, parent))).toBe(true);
      expect(existsSync(join(home, parent, 'old'))).toBe(false);
      expect(existsSync(join(home, parent, 'recent'))).toBe(true);
    }
  });

  it('leaves checkout-work children newer than forty-eight hours untouched', () => {
    const { root, home } = makeHome();
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    mkdirSync(join(home, 'mergify-admin-requeue-work', 'recent'), { recursive: true });
    age(join(home, 'mergify-admin-requeue-work', 'recent'), 1 * 60 * 60 * 1000, nowMs);

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ removed: 0, skipped: 1 });
    expect(existsSync(join(home, 'mergify-admin-requeue-work', 'recent'))).toBe(true);
    expect(readdirSync(join(home, 'mergify-admin-requeue-work'))).toEqual(['recent']);
  });
});

describe('pruneHourlySnapshotsOnReaperSchedule', () => {
  it('prunes hourly snapshots with the existing configured retention', () => {
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 4);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    expect(pruneHourlySnapshotsOnReaperSchedule({ invokerHome: home, userHome: root })).toBe(2);

    const kept = readdirSync(backupDir).filter((name) => name.startsWith('invoker.db.hourly-auto-'));
    expect(kept).toEqual([
      'invoker.db.hourly-auto-20260101-000002-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
    ]);
  });

  it('leaves hourly snapshots alone when they are within retention', () => {
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '2';

    expect(pruneHourlySnapshotsOnReaperSchedule({ invokerHome: home, userHome: root })).toBe(0);
    expect(readdirSync(backupDir)).toHaveLength(2);
  });
});

describe('trimInvokerLogs', () => {
  it('trims known large Invoker logs in place to the requested tail size', () => {
    const { root, home } = makeHome();
    const logPath = join(home, 'invoker.log');
    writeFileSync(logPath, Buffer.concat([
      Buffer.from('start'),
      Buffer.alloc(120, 0x61),
      Buffer.from('keep-this-tail'),
    ]));

    const result = trimInvokerLogs({ invokerHome: home, userHome: root, maxBytes: 100, keepBytes: 20 });

    expect(result.trimmed).toBe(1);
    expect(statSync(logPath).size).toBe(20);
    expect(readFileSync(logPath, 'utf8')).toBe('aaaaaaakeep-this-tail');
  });

  it('leaves known logs below the size threshold untouched and ignores unrelated logs', () => {
    const { root, home } = makeHome();
    const guiLog = join(home, 'gui.log');
    const unrelated = join(home, 'random.log');
    writeFileSync(guiLog, 'small-log');
    truncateSync(unrelated, 150);

    const result = trimInvokerLogs({ invokerHome: home, userHome: root, maxBytes: 100, keepBytes: 20 });

    expect(result).toMatchObject({ trimmed: 0 });
    expect(readFileSync(guiLog, 'utf8')).toBe('small-log');
    expect(statSync(unrelated).size).toBe(150);
  });
});
