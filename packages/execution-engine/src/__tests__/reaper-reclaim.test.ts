import {
  execFileSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import {
  AUTOMATION_CHECKOUT_DIRS,
  buildDeletingOrphanReapScript,
  buildStaleWorktreeReapScript,
  DELETING_ORPHAN_MIN_AGE_MINUTES,
  enforceHourlySnapshotRetention,
  reapDeletingOrphans,
  reapStaleInvokerCliTempDirs,
  reapLocalStaleWorktrees,
  reapStaleAutomationCheckouts,
  reapStaleWorktrees,
  STALE_WORKTREE_MIN_AGE_HOURS,
  trimOversizedLogs,
} from '../workers/reaper-reclaim.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const tempDirs: string[] = [];
const mockedExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockedExecFileSync.mockReset();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function backdate(path: string, ageMs: number): void {
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

describe('reapDeletingOrphans', () => {
  it('removes a stale dot-deleting orphan locally and leaves a fresh one alone', async () => {
    const { root, home } = makeHome();
    mkdirSync(join(home, 'merge-clones.deleting.123', 'stale'), { recursive: true });
    writeFileSync(join(home, 'merge-clones.deleting.123', 'stale', 'file.txt'), 'x');
    backdate(join(home, 'merge-clones.deleting.123'), 40 * 60 * 1000);
    mkdirSync(join(home, 'repos.deleting.999'), { recursive: true });
    mkdirSync(join(home, 'worktrees', 'active'), { recursive: true });
    writeFileSync(join(home, 'invoker.db'), 'keep-me');

    const results = await reapDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, reason: 'reap-orphans', detail: 'removed 1' });
    expect(existsSync(join(home, 'merge-clones.deleting.123'))).toBe(false);
    expect(existsSync(join(home, 'repos.deleting.999'))).toBe(true);
    expect(existsSync(join(home, 'worktrees', 'active'))).toBe(true);
    expect(existsSync(join(home, 'invoker.db'))).toBe(true);
  });

  it('runs the age-gated orphan reap script on every configured remote target', async () => {
    const { root, home } = makeHome();
    const target: RemoteDiskTarget = {
      name: 'remote-1',
      connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
      remotePath: '~/.invoker',
    };
    const runRemoteScript = vi.fn(async () => 'ok');

    const results = await reapDeletingOrphans({
      invokerHome: home,
      userHome: root,
      remoteTargets: [target],
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true, targetKey: 'ssh:remote-1 ~/.invoker' });
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    const script = runRemoteScript.mock.calls[0]?.[1] as unknown as string;
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("-name '*.deleting.*'");
    expect(script).toContain(`-mmin +${DELETING_ORPHAN_MIN_AGE_MINUTES}`);
    expect(script).toContain('-maxdepth 1');
    expect(script).not.toContain('pkill');
  });

  it('refuses unsafe local and remote homes without touching anything', async () => {
    const runRemoteScript = vi.fn(async () => 'ok');
    const results = await reapDeletingOrphans({
      invokerHome: '/',
      remoteTargets: [
        { name: 'remote-1', connection: { host: 'h', user: 'u', sshKeyPath: '/k' }, remotePath: '~' },
      ],
      runRemoteScript,
    });

    expect(results[0]).toMatchObject({ ok: false, reason: 'path-guard' });
    expect(results[1]).toMatchObject({ ok: false, reason: 'path-guard' });
    expect(runRemoteScript).not.toHaveBeenCalled();
  });

  it('embeds only the narrow orphan glob in the remote script, not the reclaimable-dir wipe', () => {
    const script = buildDeletingOrphanReapScript('~/.invoker');
    expect(script).toContain("'*.deleting.*'");
    expect(script).not.toContain('$INVOKER_HOME/worktrees');
    expect(script).not.toContain('$INVOKER_HOME/repos');
    expect(script).not.toContain('TMP_CLEAN');
  });
});

describe('reapStaleWorktrees', () => {
  it('leaves worktree entries younger than forty-eight hours untouched', () => {
    const { root, home } = makeHome();
    mkdirSync(join(home, 'repos', 'repoabc123456'), { recursive: true });
    mkdirSync(join(home, 'worktrees', 'repoabc123456', 'fresh-branch'), { recursive: true });

    const removed = reapLocalStaleWorktrees({ invokerHome: home, userHome: root });

    expect(removed).toEqual([]);
    expect(existsSync(join(home, 'worktrees', 'repoabc123456', 'fresh-branch'))).toBe(true);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('removes stale entries with git worktree remove and prunes once per repo group', () => {
    const { root, home } = makeHome();
    const repoHash = 'repoabc123456';
    const oldA = join(home, 'worktrees', repoHash, 'old-a');
    const oldB = join(home, 'worktrees', repoHash, 'old-b');
    mkdirSync(join(home, 'repos', repoHash), { recursive: true });
    mkdirSync(oldA, { recursive: true });
    mkdirSync(oldB, { recursive: true });
    backdate(oldA, (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
    backdate(oldB, (STALE_WORKTREE_MIN_AGE_HOURS + 2) * 60 * 60 * 1000);
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv[3] === 'remove') rmSync(argv[5]!, { recursive: true, force: true });
      return Buffer.from('');
    });

    const removed = reapLocalStaleWorktrees({ invokerHome: home, userHome: root });

    expect(removed.sort()).toEqual([oldA, oldB].sort());
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    const calls = mockedExecFileSync.mock.calls.map((call) => call[1] as string[]);
    expect(calls.filter((args) => args[3] === 'remove')).toHaveLength(2);
    expect(calls.filter((args) => args[3] === 'prune')).toHaveLength(1);
    expect(calls.find((args) => args[3] === 'prune')).toEqual([
      '-C',
      join(home, 'repos', repoHash),
      'worktree',
      'prune',
    ]);
  });

  it('falls back to rm -rf when git worktree remove fails', () => {
    const { root, home } = makeHome();
    const repoHash = 'repoabc123456';
    const old = join(home, 'worktrees', repoHash, 'old-fallback');
    mkdirSync(join(home, 'repos', repoHash), { recursive: true });
    mkdirSync(old, { recursive: true });
    backdate(old, (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv[3] === 'remove') throw new Error('worktree metadata missing');
      return Buffer.from('');
    });

    const removed = reapLocalStaleWorktrees({ invokerHome: home, userHome: root });

    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    const calls = mockedExecFileSync.mock.calls.map((call) => call[1] as string[]);
    expect(calls.filter((args) => args[3] === 'remove')).toHaveLength(1);
    expect(calls.filter((args) => args[3] === 'prune')).toHaveLength(1);
  });

  it('builds and runs the age-gated stale-worktree reap script on remote targets', async () => {
    const { root, home } = makeHome();
    const target: RemoteDiskTarget = {
      name: 'remote-1',
      connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
      remotePath: '~/.invoker',
    };
    const runRemoteScript = vi.fn(async () => 'removed /home/u/.invoker/worktrees/repo/old\n');

    const results = await reapStaleWorktrees({
      invokerHome: home,
      userHome: root,
      remoteTargets: [target],
      runRemoteScript,
    });

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      ok: true,
      targetKey: 'ssh:remote-1 ~/.invoker',
      reason: 'reap-worktrees',
      detail: 'removed 1',
    });
    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    const script = runRemoteScript.mock.calls[0]?.[1] as unknown as string;
    expect(script).toContain('INVOKER_HOME=\'~/.invoker\'');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain('find "$INVOKER_HOME/worktrees" -mindepth 2 -maxdepth 2 -type d');
    expect(script).toContain(`-mmin +${STALE_WORKTREE_MIN_AGE_HOURS * 60}`);
    expect(script).toContain('git -C "$repo" worktree remove --force "$path"');
    expect(script).toContain('rm -rf "$path"');
    expect(script).toContain('git -C "$INVOKER_HOME/repos/$repo_hash" worktree prune');
  });

  it('does not include the orphan glob in the stale-worktree remote script', () => {
    const script = buildStaleWorktreeReapScript('~/.invoker', STALE_WORKTREE_MIN_AGE_HOURS);
    expect(script).toContain('$INVOKER_HOME/worktrees');
    expect(script).toContain('$INVOKER_HOME/repos/$repo_hash');
    expect(script).not.toContain("'*.deleting.*'");
  });
});

describe('reapStaleAutomationCheckouts', () => {
  it('removes children older than forty-eight hours and keeps fresh ones and the locations', () => {
    const { root, home } = makeHome();
    for (const dirName of AUTOMATION_CHECKOUT_DIRS) {
      mkdirSync(join(home, dirName, 'old-item', 'checkout'), { recursive: true });
      writeFileSync(join(home, dirName, 'old-item', 'checkout', 'file.txt'), 'x');
      backdate(join(home, dirName, 'old-item'), 49 * 60 * 60 * 1000);
      mkdirSync(join(home, dirName, 'fresh-item'), { recursive: true });
    }

    const removed = reapStaleAutomationCheckouts({ invokerHome: home, userHome: root });

    expect(removed).toHaveLength(AUTOMATION_CHECKOUT_DIRS.length);
    for (const dirName of AUTOMATION_CHECKOUT_DIRS) {
      expect(existsSync(join(home, dirName))).toBe(true);
      expect(existsSync(join(home, dirName, 'old-item'))).toBe(false);
      expect(existsSync(join(home, dirName, 'fresh-item'))).toBe(true);
    }
  });

  it('returns nothing when the locations are absent', () => {
    const { root, home } = makeHome();
    expect(reapStaleAutomationCheckouts({ invokerHome: home, userHome: root })).toEqual([]);
  });
});

describe('reapStaleInvokerCliTempDirs', () => {
  it('removes stale CLI test directories while preserving fresh and unrelated temp entries', async () => {
    const { root } = makeHome();
    const tempRoot = join(root, 'tmp');
    const stale = join(tempRoot, 'invoker-cli-prompt-stale');
    const fresh = join(tempRoot, 'invoker-cli-prompt-fresh');
    const unrelated = join(tempRoot, 'other-tool-stale');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    backdate(stale, 49 * 60 * 60 * 1000);
    backdate(unrelated, 49 * 60 * 60 * 1000);

    const removed = await reapStaleInvokerCliTempDirs({ tempRoot, userHome: join(root, 'user') });

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('refuses unsafe temp roots', async () => {
    const { root } = makeHome();
    const userHome = join(root, 'user');
    mkdirSync(userHome, { recursive: true });

    await expect(reapStaleInvokerCliTempDirs({ tempRoot: '/', userHome })).resolves.toEqual([]);
    await expect(reapStaleInvokerCliTempDirs({ tempRoot: userHome, userHome })).resolves.toEqual([]);
  });
});

describe('enforceHourlySnapshotRetention', () => {
  it('trims a pile larger than the configured limit to exactly that limit', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '2');
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 4; i += 1) {
      writeFileSync(join(backupDir, `invoker.db.hourly-auto-20260101-00000${i}-000Z`), `${i}`);
    }
    writeFileSync(join(backupDir, 'invoker.db.before-delete-all-20260101-000001-000Z'), 'manual');

    const removed = enforceHourlySnapshotRetention(home, root);

    expect(removed).toBe(2);
    const remaining = readdirSync(backupDir).sort();
    expect(remaining).toEqual([
      'invoker.db.before-delete-all-20260101-000001-000Z',
      'invoker.db.hourly-auto-20260101-000003-000Z',
      'invoker.db.hourly-auto-20260101-000004-000Z',
    ]);
  });

  it('leaves a pile within the configured limit alone', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '2');
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'invoker.db.hourly-auto-20260101-000001-000Z'), '1');

    expect(enforceHourlySnapshotRetention(home, root)).toBe(0);
    expect(readdirSync(backupDir)).toEqual(['invoker.db.hourly-auto-20260101-000001-000Z']);
  });
});

describe('trimOversizedLogs', () => {
  it('rewrites an oversized log in place keeping only its most recent portion', () => {
    const { root, home } = makeHome();
    const big = 'a'.repeat(90) + '0123456789';
    writeFileSync(join(home, 'invoker.log'), big);
    writeFileSync(join(home, 'other-worker.log'), big);

    const trimmed = trimOversizedLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 50,
      keepBytes: 10,
    });

    expect(trimmed.sort()).toEqual([join(home, 'invoker.log'), join(home, 'other-worker.log')]);
    expect(readFileSync(join(home, 'invoker.log'), 'utf8')).toBe('0123456789');
    expect(readFileSync(join(home, 'other-worker.log'), 'utf8')).toBe('0123456789');
  });

  it('leaves a small log and non-log files alone', () => {
    const { root, home } = makeHome();
    writeFileSync(join(home, 'gui.log'), 'small');
    writeFileSync(join(home, 'invoker.db'), 'x'.repeat(100));

    const trimmed = trimOversizedLogs({
      invokerHome: home,
      userHome: root,
      maxBytes: 50,
      keepBytes: 10,
    });

    expect(trimmed).toEqual([]);
    expect(readFileSync(join(home, 'gui.log'), 'utf8')).toBe('small');
    expect(readFileSync(join(home, 'invoker.db'), 'utf8')).toBe('x'.repeat(100));
  });
});
