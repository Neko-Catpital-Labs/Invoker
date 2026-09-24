import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  symlinkSync,
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
import { DEFAULT_DISK_CRITICAL_PERCENT } from '../workers/disk-headroom.js';
import {
  AUTOMATION_CHECKOUT_DIRS,
  buildDeletingOrphanReapScript,
  buildStaleWorktreeReapScript,
  CRITICAL_PRESSURE_SNAPSHOT_RETENTION,
  DELETING_ORPHAN_MIN_AGE_MINUTES,
  enforceHourlySnapshotRetention,
  reapDeletingOrphans,
  reapStaleAgentArtifacts,
  reapStaleInvokerCliTempDirs,
  reapLocalStaleWorktrees,
  reapStaleAutomationCheckouts,
  reapStaleDevelopmentHomes,
  reapStaleDevelopmentWorktrees,
  reapStaleMergeClones,
  reapStaleWorktrees,
  STALE_AGENT_ARTIFACT_MIN_AGE_DAYS,
  STALE_DEVELOPMENT_HOME_MIN_AGE_DAYS,
  STALE_MERGE_CLONE_MIN_AGE_HOURS,
  STALE_WORKTREE_GIT_TIMEOUT_MS,
  STALE_WORKTREE_MIN_AGE_HOURS,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];

afterEach(() => {
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
  it('leaves worktree entries younger than forty-eight hours untouched', async () => {
    const { root, home } = makeHome();
    mkdirSync(join(home, 'repos', 'repoabc123456'), { recursive: true });
    mkdirSync(join(home, 'worktrees', 'repoabc123456', 'fresh-branch'), { recursive: true });
    const runLocalGit = vi.fn(async () => {});

    const removed = await reapLocalStaleWorktrees({ invokerHome: home, userHome: root, runLocalGit, inUsePaths: new Set() });

    expect(removed).toEqual([]);
    expect(existsSync(join(home, 'worktrees', 'repoabc123456', 'fresh-branch'))).toBe(true);
    expect(runLocalGit).not.toHaveBeenCalled();
  });

  it('removes stale entries with git worktree remove and prunes once per repo group', async () => {
    const { root, home } = makeHome();
    const repoHash = 'repoabc123456';
    const oldA = join(home, 'worktrees', repoHash, 'old-a');
    const oldB = join(home, 'worktrees', repoHash, 'old-b');
    mkdirSync(join(home, 'repos', repoHash), { recursive: true });
    mkdirSync(oldA, { recursive: true });
    mkdirSync(oldB, { recursive: true });
    backdate(oldA, (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
    backdate(oldB, (STALE_WORKTREE_MIN_AGE_HOURS + 2) * 60 * 60 * 1000);
    const runLocalGit = vi.fn(async (argv: string[]) => {
      if (argv[3] === 'remove') rmSync(argv[5]!, { recursive: true, force: true });
    });

    const removed = await reapLocalStaleWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit,
      inUsePaths: new Set(),
    });

    expect(removed.sort()).toEqual([oldA, oldB].sort());
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    const calls = runLocalGit.mock.calls.map((call) => call[0]);
    expect(calls.filter((args) => args[3] === 'remove')).toHaveLength(2);
    expect(calls.filter((args) => args[3] === 'prune')).toHaveLength(1);
    expect(calls.find((args) => args[3] === 'prune')).toEqual([
      '-C',
      join(home, 'repos', repoHash),
      'worktree',
      'prune',
    ]);
    expect(runLocalGit.mock.calls.every((call) => call[1] === STALE_WORKTREE_GIT_TIMEOUT_MS))
      .toBe(true);
  });

  it('falls back to rm -rf when git worktree remove fails', async () => {
    const { root, home } = makeHome();
    const repoHash = 'repoabc123456';
    const old = join(home, 'worktrees', repoHash, 'old-fallback');
    mkdirSync(join(home, 'repos', repoHash), { recursive: true });
    mkdirSync(old, { recursive: true });
    backdate(old, (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
    const runLocalGit = vi.fn(async (argv: string[]) => {
      if (argv[3] === 'remove') throw new Error('worktree metadata missing');
    });

    const removed = await reapLocalStaleWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit,
      inUsePaths: new Set(),
    });

    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    const calls = runLocalGit.mock.calls.map((call) => call[0]);
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
      taskStore: worktreeTaskStore([]),
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

  function worktreeTaskStore(tasks: Array<{ status: string; workspacePath: string }>) {
    return {
      listWorkflows: () => [{ id: 'wf-1' }],
      loadTasks: () => tasks.map((task, index) => ({
        id: `t-${index}`,
        status: task.status,
        execution: { workspacePath: task.workspacePath },
      })) as any,
    };
  }

  function seedStaleWorktrees(home: string, repoHash: string, branches: string[]): string[] {
    mkdirSync(join(home, 'repos', repoHash), { recursive: true });
    return branches.map((branch) => {
      const path = join(home, 'worktrees', repoHash, branch);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'file.txt'), branch);
      backdate(path, (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
      return path;
    });
  }

  const removingLocalGit = () => vi.fn(async (argv: string[]) => {
    if (argv[3] === 'remove') rmSync(argv[5]!, { recursive: true, force: true });
  });

  it('keeps an old worktree an unfinished task still uses and removes an idle one', async () => {
    const { root, home } = makeHome();
    const [inUse, idle] = seedStaleWorktrees(home, 'repoabc123456', ['in-use', 'idle']);

    const results = await reapStaleWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit: removingLocalGit(),
      taskStore: worktreeTaskStore([{ status: 'running', workspacePath: inUse! }]),
    });

    expect(results[0]).toMatchObject({ ok: true, detail: 'removed 1' });
    expect(existsSync(join(inUse!, 'file.txt'))).toBe(true);
    expect(existsSync(idle!)).toBe(false);
  });

  it('keeps an old worktree whose own in-use mark is fresh even when no local task names it', async () => {
    const { root, home } = makeHome();
    const [marked, idle] = seedStaleWorktrees(home, 'repoabc123456', ['marked', 'idle']);
    mkdirSync(join(home, 'in-use', 'worktrees', 'repoabc123456'), { recursive: true });
    writeFileSync(join(home, 'in-use', 'worktrees', 'repoabc123456', 'marked'), '');

    await reapStaleWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit: removingLocalGit(),
      taskStore: worktreeTaskStore([]),
    });

    expect(existsSync(join(marked!, 'file.txt'))).toBe(true);
    expect(existsSync(idle!)).toBe(false);
  });

  it('removes nothing locally or remotely and reports why when no task store is given', async () => {
    const { root, home } = makeHome();
    const [old] = seedStaleWorktrees(home, 'repoabc123456', ['old']);
    const runRemoteScript = vi.fn(async () => '');

    const results = await reapStaleWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit: removingLocalGit(),
      remoteTargets: [{ name: 'remote-1', connection: { host: 'h', user: 'u', sshKeyPath: '/k' }, remotePath: '~/.invoker' }],
      runRemoteScript,
    });

    expect(existsSync(old!)).toBe(true);
    expect(runRemoteScript).not.toHaveBeenCalled();
    expect(results.map((result) => result.reason)).toEqual(['no-task-store', 'no-task-store']);
  });

  it('keeps in-use and freshly marked worktrees when the remote reap script runs for real', async () => {
    const { root, home } = makeHome();
    const [inUse, marked, idle] = seedStaleWorktrees(home, 'repoabc123456', ['in-use', 'marked', 'idle']);
    mkdirSync(join(home, 'in-use', 'worktrees', 'repoabc123456'), { recursive: true });
    writeFileSync(join(home, 'in-use', 'worktrees', 'repoabc123456', 'marked'), '');
    const localGitCalls: string[][] = [];
    const runRemoteScript = vi.fn(async (_target: RemoteDiskTarget, script: string) => {
      const scriptPath = join(root, 'reap.sh');
      writeFileSync(scriptPath, script);
      const run = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      return run.stdout;
    });

    await reapStaleWorktrees({
      invokerHome: join(root, 'unused-local-home'),
      userHome: root,
      runLocalGit: vi.fn(async (argv: string[]) => { localGitCalls.push(argv); }),
      remoteTargets: [{ name: 'owner-host', connection: { host: 'h', user: 'u', sshKeyPath: '/k' }, remotePath: home }],
      runRemoteScript,
      taskStore: worktreeTaskStore([{ status: 'running', workspacePath: inUse! }]),
    });

    expect(runRemoteScript).toHaveBeenCalledTimes(1);
    expect(existsSync(join(inUse!, 'file.txt'))).toBe(true);
    expect(existsSync(join(marked!, 'file.txt'))).toBe(true);
    expect(existsSync(idle!)).toBe(false);
  });

  it('does not include the orphan glob in the stale-worktree remote script', () => {
    const script = buildStaleWorktreeReapScript('~/.invoker', STALE_WORKTREE_MIN_AGE_HOURS, []);
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

describe('reapStaleMergeClones', () => {
  function taskStore(tasks: Array<{ status: string; workspacePath: string }>) {
    return {
      listWorkflows: () => [{ id: 'wf-1' }],
      loadTasks: () => tasks.map((task, index) => ({
        id: `t-${index}`,
        status: task.status,
        execution: { workspacePath: task.workspacePath },
      })) as any,
    };
  }

  it('removes stale clones, keeps fresh ones, and keeps a stale clone an unfinished task still uses', async () => {
    const { root, home } = makeHome();
    const staleAge = (STALE_MERGE_CLONE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000;
    for (const name of ['gate-old-Aa1', 'gate-done-Bb2', 'gate-running-Cc3']) {
      mkdirSync(join(home, 'merge-clones', name, '.git'), { recursive: true });
      backdate(join(home, 'merge-clones', name), staleAge);
    }
    mkdirSync(join(home, 'merge-clones', 'gate-fresh-Dd4'), { recursive: true });

    const result = await reapStaleMergeClones({
      invokerHome: home,
      userHome: root,
      taskStore: taskStore([
        { status: 'completed', workspacePath: join(home, 'merge-clones', 'gate-done-Bb2') },
        { status: 'running', workspacePath: join(home, 'merge-clones', 'gate-running-Cc3') },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.removed.sort()).toEqual([
      join(home, 'merge-clones', 'gate-done-Bb2'),
      join(home, 'merge-clones', 'gate-old-Aa1'),
    ]);
    expect(existsSync(join(home, 'merge-clones', 'gate-running-Cc3'))).toBe(true);
    expect(existsSync(join(home, 'merge-clones', 'gate-fresh-Dd4'))).toBe(true);
  });

  it('removes nothing and reports why when task state cannot be read', async () => {
    const { root, home } = makeHome();
    mkdirSync(join(home, 'merge-clones', 'gate-old-Aa1'), { recursive: true });
    backdate(join(home, 'merge-clones', 'gate-old-Aa1'), (STALE_MERGE_CLONE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

    const unreadable = await reapStaleMergeClones({
      invokerHome: home,
      userHome: root,
      logger,
      taskStore: {
        listWorkflows: () => {
          throw new Error('database is locked');
        },
        loadTasks: () => [],
      },
    });
    const missing = await reapStaleMergeClones({ invokerHome: home, userHome: root });

    expect(unreadable).toEqual({ ok: false, removed: [], reason: 'task-store-error: database is locked' });
    expect(missing).toEqual({ ok: false, removed: [], reason: 'no-task-store' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('database is locked'), expect.anything());
    expect(existsSync(join(home, 'merge-clones', 'gate-old-Aa1'))).toBe(true);
  });
});

describe('reapStaleDevelopmentHomes', () => {
  const staleAge = (STALE_DEVELOPMENT_HOME_MIN_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;

  function makeDevHome(home: string, id: string, opts: { lockPid?: string; ageMs?: number } = {}): string {
    const devHome = join(home, 'dev', id);
    mkdirSync(join(devHome, 'db-backups'), { recursive: true });
    writeFileSync(join(devHome, 'invoker.db'), 'dev-db');
    writeFileSync(join(devHome, 'invoker.log'), 'log');
    if (opts.lockPid !== undefined) {
      mkdirSync(join(devHome, 'invoker.db.lock'), { recursive: true });
      writeFileSync(join(devHome, 'invoker.db.lock', 'pid'), `${opts.lockPid}\n`);
      if (opts.ageMs !== undefined) {
        backdate(join(devHome, 'invoker.db.lock', 'pid'), opts.ageMs);
        backdate(join(devHome, 'invoker.db.lock'), opts.ageMs);
      }
    }
    if (opts.ageMs !== undefined) {
      for (const name of ['db-backups', 'invoker.db', 'invoker.log']) backdate(join(devHome, name), opts.ageMs);
      backdate(devHome, opts.ageMs);
    }
    return devHome;
  }

  it('removes an old dev home whose recorded process is gone and keeps fresh or still-running ones', async () => {
    const { root, home } = makeHome();
    writeFileSync(join(home, 'invoker.db'), 'production-db');
    const abandoned = makeDevHome(home, 'aaaa000001', { lockPid: '11111', ageMs: staleAge });
    const running = makeDevHome(home, 'bbbb000002', { lockPid: '22222', ageMs: staleAge });
    const fresh = makeDevHome(home, 'cccc000003', { lockPid: '33333' });
    const recentlyLogged = makeDevHome(home, 'dddd000004', { ageMs: staleAge });
    writeFileSync(join(recentlyLogged, 'invoker.log'), 'written today');

    const result = await reapStaleDevelopmentHomes({
      invokerHome: home,
      userHome: root,
      isProcessAlive: (pid) => pid === 22222,
    });

    expect(result).toEqual({ ok: true, removed: [abandoned], unchecked: [] });
    expect(existsSync(running)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(recentlyLogged)).toBe(true);
    expect(readFileSync(join(home, 'invoker.db'), 'utf8')).toBe('production-db');
  });

  it('keeps an old dev home whose lock cannot be read and reports it as unchecked', async () => {
    const { root, home } = makeHome();
    const devHome = makeDevHome(home, 'eeee000005', { ageMs: staleAge });
    mkdirSync(join(devHome, 'gui-window.lock', 'pid'), { recursive: true });
    backdate(join(devHome, 'gui-window.lock', 'pid'), staleAge);
    backdate(join(devHome, 'gui-window.lock'), staleAge);
    backdate(devHome, staleAge);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

    const result = await reapStaleDevelopmentHomes({
      invokerHome: home,
      userHome: root,
      logger,
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [devHome] });
    expect(existsSync(devHome)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gui-window.lock'), expect.anything());
  });

  it('keeps an old dev home when a file deep inside it changed recently', async () => {
    const { root, home } = makeHome();
    const devHome = makeDevHome(home, 'ffff000006', { ageMs: staleAge });
    mkdirSync(join(devHome, 'agent-sessions', 'session-1'), { recursive: true });
    writeFileSync(join(devHome, 'agent-sessions', 'session-1', 'transcript.jsonl'), 'written today');
    backdate(join(devHome, 'agent-sessions', 'session-1'), staleAge);
    backdate(join(devHome, 'agent-sessions'), staleAge);
    backdate(devHome, staleAge);

    const result = await reapStaleDevelopmentHomes({
      invokerHome: home,
      userHome: root,
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [] });
    expect(existsSync(devHome)).toBe(true);
  });

  it('keeps an old dev home whose worker lock file names a running process', async () => {
    const { root, home } = makeHome();
    const devHome = makeDevHome(home, 'aaaa000007', { ageMs: staleAge });
    mkdirSync(join(devHome, 'locks'), { recursive: true });
    writeFileSync(join(devHome, 'locks', 'worker-reaper.lock'), JSON.stringify({ kind: 'reaper', pid: 44444 }));
    backdate(join(devHome, 'locks', 'worker-reaper.lock'), staleAge);
    backdate(join(devHome, 'locks'), staleAge);
    backdate(devHome, staleAge);

    const result = await reapStaleDevelopmentHomes({
      invokerHome: home,
      userHome: root,
      isProcessAlive: (pid) => pid === 44444,
    });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [] });
    expect(existsSync(devHome)).toBe(true);
  });

  it('keeps an old dev home whose lock pid is not a plain positive number and reports it as unchecked', async () => {
    const { root, home } = makeHome();
    const devHome = makeDevHome(home, 'bbbb000008', { lockPid: '123abc', ageMs: staleAge });

    const result = await reapStaleDevelopmentHomes({
      invokerHome: home,
      userHome: root,
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [devHome] });
    expect(existsSync(devHome)).toBe(true);
  });

  it('does nothing when there is no dev folder', async () => {
    const { root, home } = makeHome();
    expect(await reapStaleDevelopmentHomes({ invokerHome: home, userHome: root })).toEqual({
      ok: true,
      removed: [],
      unchecked: [],
    });
  });
});

describe('reapStaleDevelopmentWorktrees', () => {
  const staleAge = (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000;

  function makeLiveDevHome(home: string, id: string): string {
    const devHome = join(home, 'dev', id);
    mkdirSync(join(devHome, 'repos', 'repohash1'), { recursive: true });
    writeFileSync(join(devHome, 'invoker.db'), 'dev-db');
    writeFileSync(join(devHome, 'invoker.log'), 'log');
    return devHome;
  }

  function makeWorktree(devHome: string, repoHash: string, branch: string, ageMs?: number): string {
    const path = join(devHome, 'worktrees', repoHash, branch);
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'index.ts'), 'x');
    if (ageMs !== undefined) {
      backdate(join(path, 'src', 'index.ts'), ageMs);
      backdate(join(path, 'src'), ageMs);
      backdate(path, ageMs);
    }
    return path;
  }

  it('removes an old worktree inside a live dev home and keeps a fresh one, the database, logs, and repos', async () => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'aaaa000001');
    const oldOne = makeWorktree(devHome, 'repohash1', 'experiment-old', staleAge);
    const freshOne = makeWorktree(devHome, 'repohash1', 'experiment-fresh');
    const oldDbTime = staleAge * 10;
    backdate(join(devHome, 'invoker.db'), oldDbTime);
    const runLocalGit = vi.fn(async () => {});

    const result = await reapStaleDevelopmentWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit,
    });

    expect(result).toEqual({ ok: true, removed: [oldOne], unchecked: [] });
    expect(existsSync(oldOne)).toBe(false);
    expect(existsSync(freshOne)).toBe(true);
    expect(readFileSync(join(devHome, 'invoker.db'), 'utf8')).toBe('dev-db');
    expect(existsSync(join(devHome, 'invoker.log'))).toBe(true);
    expect(existsSync(join(devHome, 'repos', 'repohash1'))).toBe(true);
    expect(runLocalGit).toHaveBeenCalledWith(
      ['-C', join(devHome, 'repos', 'repohash1'), 'worktree', 'prune'],
      STALE_WORKTREE_GIT_TIMEOUT_MS,
    );
  });

  it('keeps an old worktree whose file changed recently', async () => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'bbbb000002');
    const path = makeWorktree(devHome, 'repohash1', 'experiment-touched', staleAge);
    writeFileSync(join(path, 'src', 'index.ts'), 'written today');
    backdate(join(path, 'src'), staleAge);
    backdate(path, staleAge);

    const result = await reapStaleDevelopmentWorktrees({ invokerHome: home, userHome: root });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [] });
    expect(existsSync(path)).toBe(true);
  });

  it('keeps an old worktree whose repo has a fresh in-use mark', async () => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'cccc000003');
    const path = makeWorktree(devHome, 'repohash1', 'experiment-marked', staleAge);
    mkdirSync(join(devHome, 'in-use', 'worktrees', 'repohash1'), { recursive: true });
    writeFileSync(join(devHome, 'in-use', 'worktrees', 'repohash1', 'experiment-marked'), '');

    const result = await reapStaleDevelopmentWorktrees({ invokerHome: home, userHome: root });

    expect(result).toEqual({ ok: true, removed: [], unchecked: [] });
    expect(existsSync(path)).toBe(true);
  });

  it('removes an old worktree whose in-use mark is itself old', async () => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'dddd000004');
    const path = makeWorktree(devHome, 'repohash1', 'experiment-old-mark', staleAge);
    const markPath = join(devHome, 'in-use', 'worktrees', 'repohash1', 'experiment-old-mark');
    mkdirSync(join(devHome, 'in-use', 'worktrees', 'repohash1'), { recursive: true });
    writeFileSync(markPath, '');
    backdate(markPath, staleAge);

    const result = await reapStaleDevelopmentWorktrees({
      invokerHome: home,
      userHome: root,
      runLocalGit: async () => {},
    });

    expect(result).toEqual({ ok: true, removed: [path], unchecked: [] });
    expect(existsSync(markPath)).toBe(true);
  });

  it('keeps an old worktree it cannot read and reports it as unchecked', async (ctx) => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'eeee000005');
    const path = makeWorktree(devHome, 'repohash1', 'experiment-locked', staleAge);
    const locked = join(path, 'src');
    chmodSync(locked, 0o000);
    try {
      let unreadable = false;
      try {
        readdirSync(locked);
      } catch {
        unreadable = true;
      }
      if (!unreadable) {
        ctx.skip(`chmod 0o000 is not enforced for uid ${process.getuid?.() ?? 'unknown'}`);
      }
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
      const result = await reapStaleDevelopmentWorktrees({ invokerHome: home, userHome: root, logger });

      expect(result).toEqual({ ok: true, removed: [], unchecked: [path] });
      expect(existsSync(path)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(locked), expect.anything());
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('never follows a symlinked worktree entry and reports it as unchecked', async () => {
    const { root, home } = makeHome();
    const devHome = makeLiveDevHome(home, 'eeee000006');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'invoker-reaper-outside-'));
    tempDirs.push(outsideRoot);
    const outsideFile = join(outsideRoot, 'keep.txt');
    writeFileSync(outsideFile, 'precious');
    backdate(outsideFile, staleAge);
    backdate(outsideRoot, staleAge);
    const repoRoot = join(devHome, 'worktrees', 'repohash1');
    mkdirSync(repoRoot, { recursive: true });
    const linkPath = join(repoRoot, 'experiment-link');
    symlinkSync(outsideRoot, linkPath);

    const result = await reapStaleDevelopmentWorktrees({ invokerHome: home, userHome: root });

    expect(result.removed).toEqual([]);
    expect(result.unchecked).toEqual([linkPath]);
    expect(existsSync(outsideFile)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('does nothing when there is no dev folder', async () => {
    const { root, home } = makeHome();
    expect(await reapStaleDevelopmentWorktrees({ invokerHome: home, userHome: root })).toEqual({
      ok: true,
      removed: [],
      unchecked: [],
    });
  });
});

describe('reapStaleAgentArtifacts', () => {
  const staleAgeMs = (STALE_AGENT_ARTIFACT_MIN_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;

  it('removes old agent-session and task-output files and keeps fresh ones, the spool, and subdirectories', () => {
    const { home } = makeHome();
    const sessions = join(home, 'agent-sessions');
    const full = join(home, 'task-output', 'full');
    const spool = join(home, 'task-output', 'spool');
    mkdirSync(join(sessions, 'nested'), { recursive: true });
    mkdirSync(full, { recursive: true });
    mkdirSync(spool, { recursive: true });
    const staleSession = join(sessions, 'old.jsonl');
    const freshSession = join(sessions, 'new.jsonl');
    const staleOutput = join(full, 'old.log');
    const freshOutput = join(full, 'new.log');
    const staleSpool = join(spool, 'old.log');
    for (const file of [staleSession, freshSession, staleOutput, freshOutput, staleSpool]) {
      writeFileSync(file, 'x');
    }
    for (const path of [staleSession, staleOutput, staleSpool, join(sessions, 'nested')]) {
      backdate(path, staleAgeMs);
    }

    const result = reapStaleAgentArtifacts({ invokerHome: home });

    expect(result.removed.sort()).toEqual([staleSession, staleOutput].sort());
    expect(result.unchecked).toEqual([]);
    expect(existsSync(staleSession)).toBe(false);
    expect(existsSync(staleOutput)).toBe(false);
    expect(existsSync(freshSession)).toBe(true);
    expect(existsSync(freshOutput)).toBe(true);
    expect(existsSync(staleSpool)).toBe(true);
    expect(existsSync(join(sessions, 'nested'))).toBe(true);
  });

  it('reports a missing directory as clean, not unchecked', () => {
    const { home } = makeHome();

    expect(reapStaleAgentArtifacts({ invokerHome: home })).toEqual({ removed: [], unchecked: [] });
  });

  it('reports an unreadable directory as unchecked', () => {
    const { home } = makeHome();
    writeFileSync(join(home, 'agent-sessions'), 'not a directory');

    const result = reapStaleAgentArtifacts({ invokerHome: home });

    expect(result.removed).toEqual([]);
    expect(result.unchecked).toEqual([join(home, 'agent-sessions')]);
  });

  it('refuses an unsafe invoker home', () => {
    expect(reapStaleAgentArtifacts({ invokerHome: '/' })).toEqual({ removed: [], unchecked: ['/'] });
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

  function seedHourlySnapshots(count: number): { root: string; home: string; backupDir: string } {
    const { root, home } = makeHome();
    const backupDir = join(home, 'db-backups');
    mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= count; i += 1) {
      writeFileSync(join(backupDir, `invoker.db.hourly-auto-20260101-0000${String(i).padStart(2, '0')}-000Z`), `${i}`);
    }
    return { root, home, backupDir };
  }

  it('keeps only the newest six snapshots under critical disk pressure', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '10');
    const { root, home, backupDir } = seedHourlySnapshots(10);
    const logger = { warn: vi.fn() };

    const removed = enforceHourlySnapshotRetention(home, root, {
      logger,
      readDiskUsedPercent: () => DEFAULT_DISK_CRITICAL_PERCENT,
    });

    expect(removed).toBe(4);
    expect(readdirSync(backupDir).sort()).toEqual([
      'invoker.db.hourly-auto-20260101-000005-000Z',
      'invoker.db.hourly-auto-20260101-000006-000Z',
      'invoker.db.hourly-auto-20260101-000007-000Z',
      'invoker.db.hourly-auto-20260101-000008-000Z',
      'invoker.db.hourly-auto-20260101-000009-000Z',
      'invoker.db.hourly-auto-20260101-000010-000Z',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the configured retention below critical disk pressure', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '10');
    const { root, home, backupDir } = seedHourlySnapshots(10);

    const removed = enforceHourlySnapshotRetention(home, root, {
      readDiskUsedPercent: () => DEFAULT_DISK_CRITICAL_PERCENT - 0.1,
    });

    expect(removed).toBe(0);
    expect(readdirSync(backupDir)).toHaveLength(10);
  });

  it('uses the configured INVOKER_DISK_CRITICAL_PERCENT as the critical threshold', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '10');
    vi.stubEnv('INVOKER_DISK_CRITICAL_PERCENT', '90');
    const { root, home, backupDir } = seedHourlySnapshots(10);

    const removed = enforceHourlySnapshotRetention(home, root, {
      readDiskUsedPercent: () => 92,
    });

    expect(removed).toBe(4);
    expect(readdirSync(backupDir)).toHaveLength(CRITICAL_PRESSURE_SNAPSHOT_RETENTION);
  });

  it('measures the db-backups directory, not the invoker home, when choosing retention', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '10');
    const { root, home, backupDir } = seedHourlySnapshots(10);
    const measured: string[] = [];

    const removed = enforceHourlySnapshotRetention(home, root, {
      readDiskUsedPercent: (target) => {
        measured.push(target);
        return target === backupDir ? DEFAULT_DISK_CRITICAL_PERCENT : 10;
      },
    });

    expect(measured).toEqual([backupDir]);
    expect(removed).toBe(4);
    expect(readdirSync(backupDir)).toHaveLength(CRITICAL_PRESSURE_SNAPSHOT_RETENTION);
  });

  it('keeps the configured retention and warns when disk usage is unreadable', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '10');
    const { root, home, backupDir } = seedHourlySnapshots(10);
    const logger = { warn: vi.fn() };

    const removed = enforceHourlySnapshotRetention(home, root, {
      logger,
      readDiskUsedPercent: () => {
        throw new Error('statfs EACCES');
      },
    });

    expect(removed).toBe(0);
    expect(readdirSync(backupDir)).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('statfs EACCES');
  });

  it('never raises retention above the configured value under critical pressure', () => {
    vi.stubEnv('INVOKER_HOURLY_BACKUP_RETENTION', '2');
    const { root, home, backupDir } = seedHourlySnapshots(10);

    const removed = enforceHourlySnapshotRetention(home, root, {
      readDiskUsedPercent: () => DEFAULT_DISK_CRITICAL_PERCENT,
    });

    expect(removed).toBe(8);
    expect(readdirSync(backupDir)).toHaveLength(2);
  });
});

