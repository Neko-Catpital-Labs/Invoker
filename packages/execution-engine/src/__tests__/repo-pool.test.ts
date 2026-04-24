import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool, ResourceLimitError } from '../repo-pool.js';
import { remoteFetchForPool } from '../remote-fetch-policy.js';

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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-pool-cache-'));
    localRepoUrl = createTempRepo();
    pool = new RepoPool({ cacheDir: tmpDir });
  });

  afterEach(async () => {
    remoteFetchForPool.enabled = true;
    await pool.destroyAll();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(localRepoUrl, { recursive: true, force: true });
  });

  it('ensureClone: clones repo on first call', async () => {
    const path = await pool.ensureClone(localRepoUrl);
    expect(path).toBeDefined();
    // Verify it's a git repo
    const result = execSync('git rev-parse --is-inside-work-tree', { cwd: path }).toString().trim();
    expect(result).toBe('true');
  });

  it('ensureClone: returns cached path on second call', async () => {
    const p1 = await pool.ensureClone(localRepoUrl);
    const p2 = await pool.ensureClone(localRepoUrl);
    expect(p1).toBe(p2);
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
    const clonePath = await pool.ensureClone(localRepoUrl);
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
    expect(wt.worktreePath).toBe(leakedPath);
    expect(existsSync(join(wt.worktreePath, '.git'))).toBe(true);
    const currentBranch = execSync('git branch --show-current', { cwd: wt.worktreePath }).toString().trim();
    expect(currentBranch).toBe(branch);

    await poolWithExternalBase.destroyAll();
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

    it('ensureClone succeeds when fetch --all fails', async () => {
      await pool.ensureClone(localRepoUrl);
      spyFetchToFail(pool);

      const path = await pool.ensureClone(localRepoUrl);
      expect(path).toBeDefined();
      expect(existsSync(path)).toBe(true);
    });

    it('refreshMirrorForRebase succeeds when fetch --all fails', async () => {
      await pool.ensureClone(localRepoUrl);
      spyFetchToFail(pool);

      const dir = await pool.refreshMirrorForRebase(localRepoUrl, 'master');
      expect(dir).toBeDefined();
      expect(existsSync(dir)).toBe(true);
    });

    it('concurrent fetches from separate pools sharing cacheDir both succeed', async () => {
      // Setup: bare repo so multiple clones can fetch concurrently
      const bareDir = mkdtempSync(join(tmpdir(), 'repo-pool-bare-'));
      const sourceDir = mkdtempSync(join(tmpdir(), 'repo-pool-src-'));
      try {
        execSync('git init --bare -b master', { cwd: bareDir });
        execSync(`git clone ${bareDir} .`, { cwd: sourceDir });
        execSync('git config user.email "t@t.com" && git config user.name "T"', { cwd: sourceDir });
        execSync('git commit --allow-empty -m "init"', { cwd: sourceDir });
        execSync('git branch -M master', { cwd: sourceDir });
        execSync('git push -u origin master', { cwd: sourceDir });
        for (let i = 0; i < 15; i++) {
          execSync(`git checkout -b experiment/b-${i} master`, { cwd: sourceDir });
          execSync(`git commit --allow-empty -m "b${i}" && git push origin experiment/b-${i}`, { cwd: sourceDir });
        }
        execSync('git checkout master', { cwd: sourceDir });

        // Initial clone via pool
        await pool.ensureClone(bareDir);

        // Force-push all branches to create stale tracking refs
        for (let i = 0; i < 15; i++) {
          execSync(`git checkout experiment/b-${i}`, { cwd: sourceDir });
          execSync(`git commit --allow-empty -m "rewrite ${i}" && git push --force origin experiment/b-${i}`, { cwd: sourceDir });
        }

        // Two separate pools share cacheDir — their fetches race on the same .git dir
        const pool2 = new RepoPool({ cacheDir: tmpDir });
        const pool3 = new RepoPool({ cacheDir: tmpDir });

        const [r1, r2] = await Promise.all([
          pool2.ensureClone(bareDir),
          pool3.ensureClone(bareDir),
        ]);

        expect(r1).toBe(r2);
        const sha = execSync('git rev-parse origin/master', { cwd: r1 }).toString().trim();
        expect(sha).toBeTruthy();

        await pool2.destroyAll();
        await pool3.destroyAll();
      } finally {
        rmSync(bareDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
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

    afterEach(() => { vi.restoreAllMocks(); });

    it('serializes concurrent refreshMirrorForRebase calls on same repo', async () => {
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      let callCount = 0;

      vi.spyOn(pool as any, 'doRefreshMirrorForRebase').mockImplementation(async () => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        const result = n === 1 ? await deferred1.promise : await deferred2.promise;
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-a', 'master');

      await flush();
      expect(log).toEqual(['enter-1']);

      deferred1.resolve('/fake/path');
      await flush();
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2']);

      deferred2.resolve('/fake/path');
      await Promise.all([p1, p2]);
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
    });

    it('serializes concurrent removeManagedBranchesInMirror calls on same repo', async () => {
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

    it('serializes cross-method calls (refreshMirror + acquireWorktree) on same repo', async () => {
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<any>();

      vi.spyOn(pool as any, 'doRefreshMirrorForRebase').mockImplementation(async () => {
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
      const log: string[] = [];
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      let callCount = 0;

      vi.spyOn(pool as any, 'doRefreshMirrorForRebase').mockImplementation(async () => {
        const n = ++callCount;
        log.push(`enter-${n}`);
        const result = n === 1 ? await deferred1.promise : await deferred2.promise;
        log.push(`exit-${n}`);
        return result;
      });

      const p1 = pool.refreshMirrorForRebase('repo-a', 'master');
      const p2 = pool.refreshMirrorForRebase('repo-b', 'master');

      await flush();
      // Both should have entered since different repos have independent chains
      expect(log).toEqual(['enter-1', 'enter-2']);

      deferred1.resolve('/fake/path-a');
      deferred2.resolve('/fake/path-b');
      await Promise.all([p1, p2]);
      expect(log).toEqual(['enter-1', 'enter-2', 'exit-1', 'exit-2']);
    });
  });

  it('ensureClone skips network refresh when remoteFetchForPool.enabled is false', async () => {
    await pool.ensureClone(localRepoUrl);
    const clonePath = pool.getClonePath(localRepoUrl);
    const shaBefore = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();

    writeFileSync(join(localRepoUrl, 'extra.md'), 'more');
    execSync('git add -A && git commit -m "upstream advance"', { cwd: localRepoUrl });

    remoteFetchForPool.enabled = false;
    await pool.ensureClone(localRepoUrl);
    const shaSkipped = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaSkipped).toBe(shaBefore);

    remoteFetchForPool.enabled = true;
    await pool.ensureClone(localRepoUrl);
    const shaFresh = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaFresh).not.toBe(shaBefore);
  });
});
