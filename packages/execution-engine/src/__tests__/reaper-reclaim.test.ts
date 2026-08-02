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
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_CHECKOUT_DIRS,
  buildDeletingOrphanReclaimScript,
  reclaimAutomationCheckoutWork,
  reclaimDeletingOrphans,
  reclaimHourlySnapshots,
  reclaimInvokerLogs,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];
const originalHourlyRetention = process.env.INVOKER_HOURLY_BACKUP_RETENTION;

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-reclaim-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function touchAge(path: string, ageMs: number, nowMs: number): void {
  const date = new Date(nowMs - ageMs);
  utimesSync(path, date, date);
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
  return readdirSync(backupDir)
    .filter((name) => name.startsWith('invoker.db.hourly-auto-'))
    .sort();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHourlyRetention === undefined) delete process.env.INVOKER_HOURLY_BACKUP_RETENTION;
  else process.env.INVOKER_HOURLY_BACKUP_RETENTION = originalHourlyRetention;
});

describe('reclaimDeletingOrphans', () => {
  it('removes only dot-deleting entries older than thirty minutes and reaches remotes', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    mkdirSync(join(home, 'merge-clones.deleting.123'), { recursive: true });
    writeFileSync(join(home, 'merge-clones.deleting.123', 'file.txt'), 'old');
    mkdirSync(join(home, 'worktrees.deleting.456'), { recursive: true });
    writeFileSync(join(home, 'worktrees.deleting.456', 'file.txt'), 'fresh');
    mkdirSync(join(home, 'ordinary-cache'), { recursive: true });
    touchAge(join(home, 'merge-clones.deleting.123'), 31 * 60 * 1000, nowMs);
    touchAge(join(home, 'worktrees.deleting.456'), 29 * 60 * 1000, nowMs);
    touchAge(join(home, 'ordinary-cache'), 24 * 60 * 60 * 1000, nowMs);

    const scripts: string[] = [];
    const results = await reclaimDeletingOrphans({
      invokerHome: home,
      userHome: root,
      nowMs,
      remoteTargets: [
        {
          name: 'r1',
          remotePath: '~/.invoker',
          connection: { host: 'example.test' },
        },
      ],
      runRemoteScript: async (_target, script) => {
        scripts.push(script);
        return 'remote ok';
      },
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ action: 'deleting-orphans', ok: true, removed: 1 });
    expect(results[1]).toMatchObject({ action: 'deleting-orphans', ok: true });
    expect(existsSync(join(home, 'merge-clones.deleting.123'))).toBe(false);
    expect(existsSync(join(home, 'worktrees.deleting.456'))).toBe(true);
    expect(existsSync(join(home, 'ordinary-cache'))).toBe(true);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("find \"$INVOKER_HOME\" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +30");
    expect(scripts[0]).not.toContain('remove_path');
  });

  it('leaves recent dot-deleting entries alone', async () => {
    const { root, home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    mkdirSync(join(home, 'repos.deleting.123'), { recursive: true });
    touchAge(join(home, 'repos.deleting.123'), 5 * 60 * 1000, nowMs);

    const results = await reclaimDeletingOrphans({ invokerHome: home, userHome: root, nowMs });

    expect(results[0]).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(join(home, 'repos.deleting.123'))).toBe(true);
  });

  it('builds a narrow remote script guarded to dot-deleting names only', () => {
    const script = buildDeletingOrphanReclaimScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("*.deleting.*");
    expect(script).not.toContain('runtime');
    expect(script).not.toContain('repos');
    expect(script).not.toContain('worktrees');
  });
});

describe('reclaimAutomationCheckoutWork', () => {
  it('removes immediate checkout-work children older than forty-eight hours', () => {
    const { root, home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (const dir of AUTOMATION_CHECKOUT_DIRS) {
      mkdirSync(join(home, dir, 'old-item', 'nested'), { recursive: true });
      mkdirSync(join(home, dir, 'fresh-item'), { recursive: true });
      touchAge(join(home, dir, 'old-item'), 49 * 60 * 60 * 1000, nowMs);
      touchAge(join(home, dir, 'fresh-item'), 2 * 60 * 60 * 1000, nowMs);
    }

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ action: 'automation-checkout-work', ok: true, removed: 2 });
    for (const dir of AUTOMATION_CHECKOUT_DIRS) {
      expect(existsSync(join(home, dir))).toBe(true);
      expect(existsSync(join(home, dir, 'old-item'))).toBe(false);
      expect(existsSync(join(home, dir, 'fresh-item'))).toBe(true);
    }
  });

  it('leaves recent checkout-work children alone', () => {
    const { root, home } = makeHome();
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    mkdirSync(join(home, 'mergify-admin-requeue-work', 'fresh-item'), { recursive: true });
    touchAge(join(home, 'mergify-admin-requeue-work', 'fresh-item'), 1 * 60 * 60 * 1000, nowMs);

    const result = reclaimAutomationCheckoutWork({ invokerHome: home, userHome: root, nowMs });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(existsSync(join(home, 'mergify-admin-requeue-work', 'fresh-item'))).toBe(true);
  });
});

describe('reclaimHourlySnapshots', () => {
  it('prunes hourly snapshots using the exported retention resolver', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 3);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '1';

    const result = reclaimHourlySnapshots({ invokerHome: home });

    expect(result).toMatchObject({ action: 'hourly-snapshots', ok: true, removed: 2 });
    expect(hourlyBaseNames(backupDir)).toEqual(['invoker.db.hourly-auto-20260101-000002-000Z']);
  });

  it('leaves snapshots alone when the resolved retention is not exceeded', () => {
    const { home } = makeHome();
    const backupDir = join(home, 'db-backups');
    seedHourly(backupDir, 2);
    process.env.INVOKER_HOURLY_BACKUP_RETENTION = '5';

    const result = reclaimHourlySnapshots({ invokerHome: home });

    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(hourlyBaseNames(backupDir)).toHaveLength(2);
  });
});

describe('reclaimInvokerLogs', () => {
  it('trims known oversized Invoker log files in place to the retained tail', () => {
    const { root, home } = makeHome();
    writeFileSync(join(home, 'invoker.log'), '0123456789abcdefghijklmnopqrstuvwxyz');
    writeFileSync(join(home, 'ui-task-graph-events.jsonl'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    writeFileSync(join(home, 'not-a-known-large.log'), 'do-not-touch-this-log');

    const result = reclaimInvokerLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 20,
      keepBytes: 8,
    });

    expect(result).toMatchObject({ action: 'invoker-log-trim', ok: true, trimmed: 2 });
    expect(readFileSync(join(home, 'invoker.log'), 'utf8')).toBe('stuvwxyz');
    expect(readFileSync(join(home, 'ui-task-graph-events.jsonl'), 'utf8')).toBe('STUVWXYZ');
    expect(readFileSync(join(home, 'not-a-known-large.log'), 'utf8')).toBe('do-not-touch-this-log');
  });

  it('leaves known log files below the size threshold alone', () => {
    const { root, home } = makeHome();
    writeFileSync(join(home, 'gui.log'), 'small');

    const result = reclaimInvokerLogs({
      invokerHome: home,
      userHome: root,
      thresholdBytes: 100,
      keepBytes: 10,
    });

    expect(result).toMatchObject({ ok: true, trimmed: 0 });
    expect(readFileSync(join(home, 'gui.log'), 'utf8')).toBe('small');
    expect(statSync(join(home, 'gui.log')).size).toBe(5);
  });
});
