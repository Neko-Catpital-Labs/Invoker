import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool, ResourceLimitError } from '../repo-pool.js';
import { remoteFetchForPool } from '../remote-fetch-policy.js';
import * as branchUtils from '../branch-utils.js';

/**
 * Creates a temp git repo with an initial commit.
 * Returns the path to the repo.
 */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-pool-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  execSync('git branch -M master', { cwd: dir });
  return dir;
}

describe('RepoPool', () => {
  let tmpDir: string;
  let localRepoUrl: string;
  let pool: RepoPool;
  let previousWorkspaceCleanup: string | undefined;

  beforeEach(() => {
    previousWorkspaceCleanup = process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP;
    delete process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP;
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-pool-cache-'));
    localRepoUrl = createTempRepo();
    pool = new RepoPool({ cacheDir: tmpDir });
  });

  afterEach(async () => {
    remoteFetchForPool.enabled = true;
    if (previousWorkspaceCleanup === undefined) {
      delete process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP;
    } else {
      process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP = previousWorkspaceCleanup;
    }
    await pool.destroyAll();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(localRepoUrl, { recursive: true, force: true });
  });

  it('ensureCloneThroughRepoQueue: clones repo on first call', async () => {
    const path = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    expect(path).toBeDefined();
    // Verify it's a git repo
    const result = execSync('git rev-parse --is-inside-work-tree', { cwd: path }).toString().trim();
    expect(result).toBe('true');
  });

  it('ensureCloneThroughRepoQueue: returns cached path on second call', async () => {
    const p1 = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    const p2 = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    expect(p1).toBe(p2);
  });

  it('uses one cache path for equivalent GitHub SSH and HTTPS URLs', () => {
    const githubPool = new RepoPool({ cacheDir: tmpDir, worktreeBaseDir: join(tmpDir, 'worktrees') });
    const httpsUrl = 'https://github.com/Neko-Catpital-Labs/Invoker';
    const sshUrl = 'git@github.com:Neko-Catpital-Labs/Invoker.git';

    expect(githubPool.getClonePath(httpsUrl)).toBe(githubPool.getClonePath(sshUrl));
    expect(githubPool.externalWorktreePath(httpsUrl, 'experiment/demo')).toBe(
      githubPool.externalWorktreePath(sshUrl, 'experiment/demo'),
    );
  });

  it('single-flights equivalent GitHub URL spellings without rewriting clone URL', async () => {
    const githubPool = new RepoPool({ cacheDir: tmpDir, worktreeBaseDir: join(tmpDir, 'worktrees') });
    const httpsUrl = 'https://github.com/Neko-Catpital-Labs/Invoker';
    const sshUrl = 'git@github.com:Neko-Catpital-Labs/Invoker.git';
    const clonePath = githubPool.getClonePath(httpsUrl);
    const ensureCloneUnqueued = vi
      .spyOn(githubPool as any, 'ensureCloneUnqueued')
      .mockImplementation(async (_repoUrl: string) => clonePath);

    const [p1, p2] = await Promise.all([
      githubPool.ensureCloneThroughRepoQueue(httpsUrl),
      githubPool.ensureCloneThroughRepoQueue(sshUrl),
    ]);

    expect(p1).toBe(clonePath);
    expect(p2).toBe(clonePath);
    expect(ensureCloneUnqueued).toHaveBeenCalledTimes(1);
    expect(ensureCloneUnqueued).toHaveBeenCalledWith(httpsUrl);
    await githubPool.destroyAll();
  });

  it('acquireWorktree: creates worktree with feature branch', async () => {
    const acquired = await pool.acquireWorktree(localRepoUrl, 'experiment/v1');
    expect(acquired.worktreePath).toBeDefined();
    expect(acquired.branch).toBe('experiment/v1');
    expect(acquired.worktreePath).not.toBe(acquired.clonePath);

    // Verify the branch exists in the worktree
    const branch = execSync('git branch --show-current', { cwd: acquired.worktreePath }).toString().trim();
    expect(branch).toBe('experiment/v1');
  });

  it('acquireWorktree: respects maxWorktrees limit', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 2 });
    await limitedPool.acquireWorktree(localRepoUrl, 'branch-1');
    await limitedPool.acquireWorktree(localRepoUrl, 'branch-2');
    await expect(limitedPool.acquireWorktree(localRepoUrl, 'branch-3')).rejects.toThrow('Worktree limit reached');
    // Verify the thrown error is a ResourceLimitError
    try {
      await limitedPool.acquireWorktree(localRepoUrl, 'branch-3');
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceLimitError);
      expect((err as ResourceLimitError).name).toBe('ResourceLimitError');
    }
    await limitedPool.destroyAll();
  });

  it('release: removes worktree and allows new acquisition', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt = await limitedPool.acquireWorktree(localRepoUrl, 'branch-1');
    await wt.release();
    // Should succeed now
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-2');
    expect(wt2.worktreePath).toBeDefined();
    await limitedPool.destroyAll();
  });

  it('destroyAll: removes all worktrees but preserves cache', async () => {
    const clonePath = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    await pool.acquireWorktree(localRepoUrl, 'b1');
    await pool.acquireWorktree(localRepoUrl, 'b2');
    await pool.destroyAll();

    // Clone should still exist
    const result = execSync('git rev-parse --is-inside-work-tree', { cwd: clonePath }).toString().trim();
    expect(result).toBe('true');
  });

  it('preserves commits on re-acquire when branch has commits ahead', async () => {
    // First acquire
    const wt1 = await pool.acquireWorktree(localRepoUrl, 'experiment/preserve-test');

    // Make a commit in the worktree (simulates cherry-pick/fix)
    writeFileSync(join(wt1.worktreePath, 'fix.txt'), 'cherry-picked fix');
    execSync('git add -A && git commit -m "cherry-pick fix"', { cwd: wt1.worktreePath });

    // Release the worktree
    await wt1.release();

    // Re-acquire the same branch — the fix commit should survive
    const wt2 = await pool.acquireWorktree(localRepoUrl, 'experiment/preserve-test');
    // The fix file should be present in the worktree
    expect(execSync('cat fix.txt', { cwd: wt2.worktreePath }).toString()).toBe('cherry-picked fix');

    await wt2.release();
  });

  it('acquireWorktree: succeeds when stale path+registration left from abandoned pool (simulated restart)', async () => {
    const wt = await pool.acquireWorktree(localRepoUrl, 'stale-restart-branch');
    expect(existsSync(wt.worktreePath)).toBe(true);
    // No wt.release() — same as crash or new process with empty in-memory active set
    const pool2 = new RepoPool({ cacheDir: tmpDir });
    const wt2 = await pool2.acquireWorktree(localRepoUrl, 'stale-restart-branch');
    expect(wt2.worktreePath).toBe(wt.worktreePath);
    const branch = execSync('git branch --show-current', { cwd: wt2.worktreePath }).toString().trim();
    expect(branch).toBe('stale-restart-branch');
    await pool2.destroyAll();
  });

  it('acquireWorktree: repairs leaked target directory even when it is not a registered worktree', async () => {
    const branch = 'experiment/leaked-dir';
    const poolWithExternalBase = new RepoPool({
      cacheDir: tmpDir,
      worktreeBaseDir: join(tmpDir, 'managed-worktrees'),
    });

    const leakedPath = poolWithExternalBase.externalWorktreePath(localRepoUrl, branch);
    mkdirSync(leakedPath, { recursive: true });
    writeFileSync(join(leakedPath, 'leaked.txt'), 'partial workspace');

    const wt = await poolWithExternalBase.acquireWorktree(localRepoUrl, branch);
    expect(realpathSync(wt.worktreePath)).toBe(realpathSync(leakedPath));
    expect(existsSync(join(wt.worktreePath, '.git'))).toBe(true);
    const currentBranch = execSync('git branch --show-current', { cwd: wt.worktreePath }).toString().trim();
    expect(currentBranch).toBe(branch);

    await poolWithExternalBase.destroyAll();
  });

  it('acquireWorktree: retries once when git reports target worktree path already exists', async () => {
    const branch = 'experiment/race-already-exists';
    const actionId = 'wf-race/task';
    const poolWithExternalBase = new RepoPool({
      cacheDir: tmpDir,
      worktreeBaseDir: join(tmpDir, 'managed-worktrees'),
    });
    const targetPath = poolWithExternalBase.externalWorktreePath(localRepoUrl, branch);

    const originalRunBashLocal = branchUtils.runBashLocal;
    let shouldFailFirstAttempt = true;
    const runBashSpy = vi
      .spyOn(branchUtils, 'runBashLocal')
      .mockImplementation(async (script, cwd) => {
        if (shouldFailFirstAttempt) {
          shouldFailFirstAttempt = false;
          const error = new Error(
            `bash exited with code 128: Preparing worktree (resetting branch '${branch}')\n` +
              `fatal: '${targetPath}' already exists`,
          );
          (error as Error & { exitCode?: number }).exitCode = 128;
          throw error;
        }
        return originalRunBashLocal(script, cwd);
      });

    try {
      const acquired = await poolWithExternalBase.acquireWorktree(
        localRepoUrl,
        branch,
        undefined,
        actionId,
        { forceFresh: true },
      );
      expect(realpathSync(acquired.worktreePath)).toBe(realpathSync(targetPath));
      expect(existsSync(join(acquired.worktreePath, '.git'))).toBe(true);
      expect(runBashSpy).toHaveBeenCalledTimes(2);
    } finally {
      runBashSpy.mockRestore();
      await poolWithExternalBase.destroyAll();
    }
  });

  it('softRelease: frees slot without removing worktree from disk', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt1 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-soft');
    const worktreePath = wt1.worktreePath;

    // Soft-release frees the slot but keeps the directory
    wt1.softRelease();
    expect(existsSync(worktreePath)).toBe(true);

    // Can acquire again — slot was freed
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-soft');
    expect(wt2.worktreePath).toBe(worktreePath); // Reused existing worktree
    await limitedPool.destroyAll();
  });

  it('softRelease then full release: both work in sequence', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt1 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-both');
    const worktreePath = wt1.worktreePath;

    // Soft-release frees slot
    wt1.softRelease();

    // Full release removes from disk (and is idempotent on the slot)
    await wt1.release();
    expect(existsSync(worktreePath)).toBe(false);

    // Can acquire again after full release
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-both');
    expect(wt2.worktreePath).toBeDefined();
    await limitedPool.destroyAll();
  });

  it('reconcileActiveWorktrees clears stale slot reservations', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt1 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-stale');

    await expect(limitedPool.acquireWorktree(localRepoUrl, 'branch-next')).rejects.toThrow('Worktree limit reached');

    limitedPool.reconcileActiveWorktrees(localRepoUrl, []);

    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-next');
    expect(wt2.worktreePath).toBeDefined();

    await wt1.release();
    await wt2.release();
    await limitedPool.destroyAll();
  });

  describe('content-addressable reuse (collision-free branch names)', () => {
    // Collision-free naming guarantees: same actionId + content can be reused
    // under a new lifecycle tag for non-fresh flows, and a hash collision
    // across actionIds is logged but not fatal.

    it('reuses a content-equivalent leftover worktree by renaming the branch (rename_to_lifecycle)', async () => {
      const actionId = 'wf-rl-1/task';
      const branchA = `experiment/${actionId}/g0.t0.aaaa-deadbe11`;
      const branchB = `experiment/${actionId}/g0.t1.abbb-deadbe11`;

      const wt1 = await pool.acquireWorktree(localRepoUrl, branchA, undefined, actionId);
      const path1 = wt1.worktreePath;
      expect(existsSync(path1)).toBe(true);
      // Simulate a crash/abandon: do not release; new pool sees the leftover.
      wt1.softRelease();

      const pool2 = new RepoPool({ cacheDir: tmpDir });
      const wt2 = await pool2.acquireWorktree(localRepoUrl, branchB, undefined, actionId);
      // The acquire should *reuse* the leftover worktree by renaming the branch.
      expect(wt2.worktreePath).toBe(path1);
      const head = execSync('git branch --show-current', { cwd: wt2.worktreePath }).toString().trim();
      expect(head).toBe(branchB);
      await pool2.destroyAll();
    });

    it('forceFresh=true provisions a new workspace path even for a content-equivalent branch', async () => {
      const actionId = 'wf-rl-2/task';
      const branchA = `experiment/${actionId}/g0.t0.aaaa-cafebabe`;
      const branchB = `experiment/${actionId}/g1.t0.abbb-cafebabe`;

      const wt1 = await pool.acquireWorktree(localRepoUrl, branchA, undefined, actionId);
      const path1 = wt1.worktreePath;
      wt1.softRelease();

      const pool2 = new RepoPool({ cacheDir: tmpDir });
      const wt2 = await pool2.acquireWorktree(
        localRepoUrl,
        branchB,
        undefined,
        actionId,
        { forceFresh: true },
      );
      expect(wt2.worktreePath).not.toBe(path1);
      const head = execSync('git branch --show-current', { cwd: wt2.worktreePath }).toString().trim();
      expect(head).toBe(branchB);
      await pool2.destroyAll();
    });

    it('still provisions a second worktree when two actionIds share a contentHash', async () => {
      const sharedHash = '12345678';
      const branchA = `experiment/wf-collide/taskA/g0.t0.aaaa-${sharedHash}`;
      const branchB = `experiment/wf-collide/taskB/g0.t0.abbb-${sharedHash}`;

      // Seed pool with one worktree at the colliding hash.
      await pool.acquireWorktree(localRepoUrl, branchA, undefined, 'wf-collide/taskA');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Acquiring a second branch with the same contentHash but different
        // actionId must NOT throw. This branch only keeps trace-level
        // telemetry for that collision path, so warn-level output is not
        // part of the contract here.
        const wt2 = await pool.acquireWorktree(
          localRepoUrl,
          branchB,
          undefined,
          'wf-collide/taskB',
        );
        expect(existsSync(wt2.worktreePath)).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('resets branch on re-acquire when no extra commits exist', async () => {
    // First acquire (no extra commits)
    const wt1 = await pool.acquireWorktree(localRepoUrl, 'experiment/clean-test');
    const head1 = execSync('git rev-parse HEAD', { cwd: wt1.worktreePath }).toString().trim();
    await wt1.release();

    // Re-acquire — should be a clean reset to HEAD
    const wt2 = await pool.acquireWorktree(localRepoUrl, 'experiment/clean-test');
    const head2 = execSync('git rev-parse HEAD', { cwd: wt2.worktreePath }).toString().trim();
    expect(head2).toBe(head1);  // Same HEAD, no extra commits

    await wt2.release();
  });

  describe('fetch resilience (concurrent ref-lock race)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    function spyFetchToFail(target: RepoPool) {
      const orig = (target as any).execGit.bind(target);
      vi.spyOn(target as any, 'execGit').mockImplementation(
        (...params: unknown[]) => {
          const args = params[0] as string[];
          const cwd = params[1] as string;
          if (args[0] === 'fetch' && args.includes('--all')) {
            return Promise.reject(new Error('cannot lock ref: is at X but expected Y'));
          }
          return orig(args, cwd);
        },
      );
    }

    it('ensureCloneThroughRepoQueue succeeds when fetch --all fails', async () => {
      await pool.ensureCloneThroughRepoQueue(localRepoUrl);
      spyFetchToFail(pool);

      const path = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
      expect(path).toBeDefined();
      expect(existsSync(path)).toBe(true);
    });

    it('refreshMirrorForRebase succeeds when fetch --all fails', async () => {
      await pool.ensureCloneThroughRepoQueue(localRepoUrl);
      spyFetchToFail(pool);

      const dir = await pool.refreshMirrorForRebase(localRepoUrl, 'master');
      expect(dir).toBeDefined();
      expect(existsSync(dir)).toBe(true);
    });

    it('skips per-base fetch after a successful full origin ref refresh', async () => {
      await pool.ensureCloneThroughRepoQueue(localRepoUrl);
      const orig = (pool as any).execGit.bind(pool);
      const execGit = vi.spyOn(pool as any, 'execGit').mockImplementation(
        (...params: unknown[]) => {
          const args = params[0] as string[];
          const cwd = params[1] as string;
          return orig(args, cwd);
        },
      );
      const timing = {
        mark: vi.fn(),
        span: vi.fn(async (_functionName, _metadata, fn) => fn()),
      };

      const dir = await pool.refreshMirrorForRebase(localRepoUrl, 'plan/missing-branch', timing);

      expect(dir).toBeDefined();
      expect(execGit).not.toHaveBeenCalledWith(
        ['fetch', 'origin', 'refs/heads/plan/missing-branch:refs/remotes/origin/plan/missing-branch'],
        expect.any(String),
      );
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.doRefreshMirrorForRebase.syncPlanBaseRemoteForRef', 'completed', {
        dir,
        baseBranch: 'plan/missing-branch',
        skipped: true,
        reason: 'origin-refs-fresh',
      });
    });

    it('reuses the base commit resolved by the rebase refresh batch', async () => {
      await pool.ensureCloneThroughRepoQueue(localRepoUrl);
      const orig = (pool as any).execGit.bind(pool);
      const execGit = vi.spyOn(pool as any, 'execGit').mockImplementation(
        (...params: unknown[]) => {
          const args = params[0] as string[];
          const cwd = params[1] as string;
          return orig(args, cwd);
        },
      );
      const timing = {
        mark: vi.fn(),
        span: vi.fn(async (_functionName, _metadata, fn) => fn()),
      };

      await pool.refreshMirrorForRebase(localRepoUrl, 'master', timing);
      execGit.mockClear();

      const commit = await pool.resolveBaseCommit(localRepoUrl, 'master', timing);

      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(execGit).not.toHaveBeenCalled();
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.resolveBaseCommit.batched', 'completed', {
        repoUrl: localRepoUrl,
        baseBranch: 'master',
      });
    });

    it('separate pools sharing cacheDir tolerate fetch failures', async () => {
      await pool.ensureCloneThroughRepoQueue(localRepoUrl);

      const pool2 = new RepoPool({ cacheDir: tmpDir });
      const pool3 = new RepoPool({ cacheDir: tmpDir });
      spyFetchToFail(pool2);
      spyFetchToFail(pool3);

      try {
        const [r1, r2] = await Promise.all([
          pool2.ensureCloneThroughRepoQueue(localRepoUrl),
          pool3.ensureCloneThroughRepoQueue(localRepoUrl),
        ]);

        expect(r1).toBe(r2);
        const sha = execSync('git rev-parse origin/master', { cwd: r1 }).toString().trim();
        expect(sha).toBeTruthy();
      } finally {
        await pool2.destroyAll();
        await pool3.destroyAll();
      }
    });
  });

  describe('repoChains serialization', () => {
    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function flush() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    function requestedBaseBranches(request: unknown): string[] {
      return typeof request === 'string'
        ? [request]
        : [...(request as { baseBranches: Set<string> }).baseBranches];
    }

    function markSyncedBaseBranches(request: unknown): void {
      if (typeof request === 'string') return;
      const batch = request as { baseBranches: Set<string>; syncedBaseBranches: Set<string> };
      for (const baseBranch of batch.baseBranches) batch.syncedBaseBranches.add(baseBranch);
    }

    function spyRefreshImplementation(impl: (repoUrl: string, request: unknown) => Promise<string>) {
      const methodName = 'doRefreshMirrorForRebaseBatch' in pool
        ? 'doRefreshMirrorForRebaseBatch'
        : 'doRefreshMirrorForRebase';
      return vi.spyOn(pool as any, methodName).mockImplementation(impl as any);
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('MECE 05: coalesces concurrent refreshMirrorForRebase calls on same repo and base branch', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      let callCount = 0;
      const timing = { mark: vi.fn(), span: vi.fn() };

      spyRefreshImplementation(async (_repoUrl, request) => {
        const n = ++callCount;
        const baseBranches = requestedBaseBranches(request);
        log.push(`enter-${n}:${baseBranches.join(',')}`);
        const result = await deferred1.promise;
        markSyncedBaseBranches(request);
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-a', 'master', timing);

      await flush();
      expect(log).toEqual([]);

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-1:master']);
      expect(callCount).toBe(1);

      deferred1.resolve('/fake/path');
      await expect(Promise.all([p1, p2])).resolves.toEqual(['/fake/path', '/fake/path']);
      expect(log).toEqual(['enter-1:master', 'exit-1']);
      expect(callCount).toBe(1);
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.refreshMirrorForRebase.batched', 'completed', {
        repoUrl: 'repo-a',
        callerCount: 2,
        baseBranchCount: 1,
      });
    });

    it('MECE 05: coalesces concurrent refreshMirrorForRebase calls on same repo with different base branches', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      let callCount = 0;
      const timing = { mark: vi.fn(), span: vi.fn() };

      spyRefreshImplementation(async (_repoUrl, request) => {
        const n = ++callCount;
        const baseBranches = requestedBaseBranches(request);
        log.push(`enter-${n}:${baseBranches.join(',')}`);
        const result = await deferred1.promise;
        markSyncedBaseBranches(request);
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-a', 'release', timing);

      await flush();
      expect(log).toEqual([]);

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-1:master,release']);
      deferred1.resolve('/fake/path-master');
      await expect(Promise.all([p1, p2])).resolves.toEqual(['/fake/path-master', '/fake/path-master']);
      expect(log).toEqual(['enter-1:master,release', 'exit-1']);
      expect(callCount).toBe(1);
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.refreshMirrorForRebase.batched', 'completed', {
        repoUrl: 'repo-a',
        callerCount: 2,
        baseBranchCount: 2,
      });
    });

    it('MECE 06: joins late recreate/rebase preparation callers while same-repo refresh is still active', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      let callCount = 0;
      const timing = { mark: vi.fn(), span: vi.fn() };

      spyRefreshImplementation(async (_repoUrl, request) => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        const result = await deferred1.promise;
        markSyncedBaseBranches(request);
        log.push(`exit-${n}:${requestedBaseBranches(request).join(',')}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-1']);

      const p2 = pool.refreshMirrorForRebase('repo-a', 'release', timing);
      await flush();
      expect(log).toEqual(['enter-1']);

      deferred1.resolve('/fake/path');
      await expect(Promise.all([p1, p2])).resolves.toEqual(['/fake/path', '/fake/path']);
      expect(log).toEqual(['enter-1', 'exit-1:master,release']);
      expect(callCount).toBe(1);
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.refreshMirrorForRebase.batched', 'completed', {
        repoUrl: 'repo-a',
        callerCount: 2,
        baseBranchCount: 2,
      });
    });

    it('MECE 06: reuses a just-refreshed same repo and base branch for immediate retries', async () => {
      vi.useFakeTimers();
      const timing = { mark: vi.fn(), span: vi.fn() };
      let callCount = 0;

      spyRefreshImplementation(async (_repoUrl, request) => {
        callCount += 1;
        markSyncedBaseBranches(request);
        return '/fake/path';
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      await vi.advanceTimersByTimeAsync(25);
      await expect(p1).resolves.toBe('/fake/path');

      await expect(pool.refreshMirrorForRebase('repo-a', 'master', timing)).resolves.toBe('/fake/path');
      expect(callCount).toBe(1);
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.refreshMirrorForRebase.recent', 'completed', {
        repoUrl: 'repo-a',
        baseBranch: 'master',
        reuseAgeMs: expect.any(Number),
      });
    });

    it('serializes concurrent removeManagedBranchesInMirror calls on same repo', async () => {
      process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP = '1';
      const log: string[] = [];
      const deferred1 = createDeferred<void>();
      const deferred2 = createDeferred<void>();
      let callCount = 0;

      vi.spyOn(pool as any, 'doRemoveManagedBranchesInMirror').mockImplementation(async () => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        if (n === 1) await deferred1.promise;
        else await deferred2.promise;
        log.push(`exit-${n}`);
      });

      const p1 = pool.removeManagedBranchesInMirror('repo-a', ['b1']);
      const p2 = pool.removeManagedBranchesInMirror('repo-a', ['b2']);

      await flush();
      expect(log).toEqual(['enter-1']);

      deferred1.resolve();
      await flush();
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2']);

      deferred2.resolve();
      await Promise.all([p1, p2]);
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
    });

    it('skips disabled removeManagedBranchesInMirror without waiting for repo chain', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferredRefresh = createDeferred<string>();
      const doRemove = vi.spyOn(pool as any, 'doRemoveManagedBranchesInMirror');
      const timing = { mark: vi.fn(), span: vi.fn() };

      vi.spyOn(pool as any, 'doRefreshMirrorForRebaseBatch').mockImplementation(async () => {
        log.push('enter-refresh');
        const result = await deferredRefresh.promise;
        log.push('exit-refresh');
        return result;
      });

      const refresh = pool.refreshMirrorForRebase('repo-a', 'master');
      await flush();
      expect(log).toEqual([]);

      await pool.removeManagedBranchesInMirror('repo-a', ['experiment/old'], timing);
      expect(log).toEqual([]);
      expect(doRemove).not.toHaveBeenCalled();
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.removeManagedBranchesInMirror', 'completed', {
        repoUrl: 'repo-a',
        enabled: false,
        skipped: true,
        reason: 'disabled',
        branchCount: 1,
      });

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-refresh']);
      deferredRefresh.resolve('/fake/path');
      await refresh;
    });

    it('skips empty removeManagedBranchesInMirror without waiting for repo chain', async () => {
      vi.useFakeTimers();
      process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP = '1';
      const log: string[] = [];
      const deferredRefresh = createDeferred<string>();
      const doRemove = vi.spyOn(pool as any, 'doRemoveManagedBranchesInMirror');
      const timing = { mark: vi.fn(), span: vi.fn() };

      vi.spyOn(pool as any, 'doRefreshMirrorForRebaseBatch').mockImplementation(async () => {
        log.push('enter-refresh');
        const result = await deferredRefresh.promise;
        log.push('exit-refresh');
        return result;
      });

      const refresh = pool.refreshMirrorForRebase('repo-a', 'master');
      await flush();
      expect(log).toEqual([]);

      await pool.removeManagedBranchesInMirror('repo-a', [], timing);
      expect(log).toEqual([]);
      expect(doRemove).not.toHaveBeenCalled();
      expect(timing.mark).toHaveBeenCalledWith('RepoPool.removeManagedBranchesInMirror', 'completed', {
        repoUrl: 'repo-a',
        enabled: true,
        skipped: true,
        reason: 'no-branches',
        branchCount: 0,
      });

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-refresh']);
      deferredRefresh.resolve('/fake/path');
      await refresh;
    });

    it('serializes cross-method calls (refreshMirror + acquireWorktree) on same repo', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<any>();

      vi.spyOn(pool as any, 'doRefreshMirrorForRebaseBatch').mockImplementation(async () => {
        log.push('enter-refresh');
        const result = await deferred1.promise;
        log.push('exit-refresh');
        return result;
      });

      vi.spyOn(pool as any, 'doAcquireWorktree').mockImplementation(async () => {
        log.push('enter-acquire');
        const result = await deferred2.promise;
        log.push('exit-acquire');
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.acquireWorktree('repo-a', 'branch-1');

      await flush();
      expect(log).toEqual([]);

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-refresh']);

      deferred1.resolve('/fake/path');
      await flush();
      expect(log).toEqual(['enter-refresh', 'exit-refresh', 'enter-acquire']);

      const fakeWorktree = { clonePath: '/fake', worktreePath: '/fake/wt', branch: 'branch-1', release: async () => {}, softRelease: () => {} };
      deferred2.resolve(fakeWorktree);
      await Promise.all([p1, p2]);
      expect(log).toEqual(['enter-refresh', 'exit-refresh', 'enter-acquire', 'exit-acquire']);
    });

    it('allows parallel execution for different repoUrls', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      let callCount = 0;

      vi.spyOn(pool as any, 'doRefreshMirrorForRebaseBatch').mockImplementation(async () => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        const result = n === 1 ? await deferred1.promise : await deferred2.promise;
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-b', 'master');

      await flush();
      expect(log).toEqual([]);

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      // Both should have entered since different repos have independent chains
      expect(log).toEqual(['enter-1', 'enter-2']);

      deferred1.resolve('/fake/path-a');
      deferred2.resolve('/fake/path-b');
      await Promise.all([p1, p2]);
      expect(log).toEqual(['enter-1', 'enter-2', 'exit-1', 'exit-2']);
    });

    it('rejects all callers in a failed refresh batch and clears state for retry', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      let callCount = 0;

      vi.spyOn(pool as any, 'doRefreshMirrorForRebaseBatch').mockImplementation(async () => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        const result = n === 1 ? await deferred1.promise : await deferred2.promise;
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-a', 'release');

      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-1']);

      deferred1.reject(new Error('refresh failed'));
      await expect(Promise.all([p1, p2])).rejects.toThrow('refresh failed');

      const p3 = pool.refreshMirrorForRebase('repo-a', 'master');
      await vi.advanceTimersByTimeAsync(25);
      await flush();
      expect(log).toEqual(['enter-1', 'enter-2']);

      deferred2.resolve('/fake/path');
      await expect(p3).resolves.toBe('/fake/path');
      expect(log).toEqual(['enter-1', 'enter-2', 'exit-2']);
    });
  });

  it('ensureCloneThroughRepoQueue skips network refresh when remoteFetchForPool.enabled is false', async () => {
    await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    const clonePath = pool.getClonePath(localRepoUrl);
    const shaBefore = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();

    writeFileSync(join(localRepoUrl, 'extra.md'), 'more');
    execSync('git add -A && git commit -m "upstream advance"', { cwd: localRepoUrl });

    remoteFetchForPool.enabled = false;
    await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    const shaSkipped = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaSkipped).toBe(shaBefore);

    remoteFetchForPool.enabled = true;
    await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    const shaFresh = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaFresh).not.toBe(shaBefore);
  });
});
